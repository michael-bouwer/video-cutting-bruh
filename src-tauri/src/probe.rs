//! Lightweight, dependency-free media probing.
//!
//! We only need enough information to decide whether a clip is HDR (and which
//! flavour) before handing it to the webview's video decoder, so instead of
//! shipping ffprobe on every platform we read the relevant container boxes
//! directly:
//!
//! * ISO-BMFF (mp4 / mov / m4v): `moov > trak > mdia > minf > stbl > stsd`
//!   sample entry plus its `colr`, `hvcC`, `av1C`, `vpcC`, `dv*C`, `mdcv`,
//!   `clli` children.
//! * Matroska / WebM: a byte-level scan of the header area for the `Colour`
//!   master element's children (good enough for files written by common muxers).

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Refuse to buffer absurdly large `moov` boxes (fragmented/broken files).
const MAX_MOOV_BYTES: u64 = 128 * 1024 * 1024;
/// How much of a Matroska file we scan for track headers.
const MKV_SCAN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    /// ITU-T H.273 colour primaries (1 = BT.709, 9 = BT.2020, ...).
    pub primaries: Option<u16>,
    /// ITU-T H.273 transfer characteristics (1 = BT.709, 16 = PQ, 18 = HLG, ...).
    pub transfer: Option<u16>,
    /// ITU-T H.273 matrix coefficients (1 = BT.709, 9 = BT.2020 NCL, ...).
    pub matrix: Option<u16>,
    pub full_range: Option<bool>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub enum HdrKind {
    #[serde(rename = "PQ")]
    Pq,
    #[serde(rename = "HLG")]
    Hlg,
    DolbyVision,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// "mp4", "mov", "matroska", "webm" or "unknown".
    pub container: String,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub bit_depth: Option<u8>,
    pub color: Option<ColorInfo>,
    pub hdr: Option<HdrKind>,
    pub dolby_vision: bool,
    /// Mastering display / content light level metadata present.
    pub hdr_metadata: bool,
    /// Whether the file has an audio track (None = couldn't tell).
    pub has_audio: Option<bool>,
}

pub fn probe(path: &Path) -> std::io::Result<MediaProbe> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();

    let mut out = MediaProbe {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size,
        container: "unknown".into(),
        ..Default::default()
    };

    let mut head = [0u8; 64];
    let n = read_up_to(&mut f, &mut head)?;
    let head = &head[..n];

    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        out.container = if head.len() >= 12 && &head[8..12] == b"qt  " { "mov" } else { "mp4" }.into();
        probe_isobmff(&mut f, size, &mut out)?;
    } else if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        out.container = if find(head, b"webm").is_some() { "webm" } else { "matroska" }.into();
        probe_matroska(&mut f, size, &mut out)?;
    }

    out.hdr = classify_hdr(&out);
    Ok(out)
}

pub fn classify_hdr(p: &MediaProbe) -> Option<HdrKind> {
    match p.color.as_ref().and_then(|c| c.transfer) {
        Some(16) => Some(HdrKind::Pq),
        Some(18) => Some(HdrKind::Hlg),
        _ if p.dolby_vision => Some(HdrKind::DolbyVision),
        // HDR10 files occasionally omit `colr` but still carry mastering metadata.
        _ if p.hdr_metadata && p.bit_depth.unwrap_or(8) >= 10 => Some(HdrKind::Pq),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// ISO-BMFF
// ---------------------------------------------------------------------------

fn probe_isobmff(f: &mut File, file_size: u64, out: &mut MediaProbe) -> std::io::Result<()> {
    let mut pos = 0u64;
    while pos + 8 <= file_size {
        f.seek(SeekFrom::Start(pos))?;
        let mut hdr = [0u8; 16];
        if read_up_to(f, &mut hdr[..8])? < 8 {
            break;
        }
        let mut box_size = be32(&hdr, 0) as u64;
        let mut hdr_len = 8u64;
        if box_size == 1 {
            if read_up_to(f, &mut hdr[8..16])? < 8 {
                break;
            }
            box_size = be64(&hdr, 8);
            hdr_len = 16;
        } else if box_size == 0 {
            box_size = file_size - pos;
        }
        if box_size < hdr_len {
            break;
        }

        if &hdr[4..8] == b"moov" {
            let body_len = box_size - hdr_len;
            if body_len > MAX_MOOV_BYTES {
                break;
            }
            let mut body = vec![0u8; body_len as usize];
            f.seek(SeekFrom::Start(pos + hdr_len))?;
            let got = read_up_to(f, &mut body)?;
            body.truncate(got);
            walk_boxes(&body, out, &mut TrakCtx::default());
            out.has_audio.get_or_insert(false);
            break;
        }
        pos += box_size;
    }
    Ok(())
}

#[derive(Default)]
struct TrakCtx {
    is_video: bool,
}

/// Iterates the boxes in `data`, yielding `(fourcc, body)`.
fn boxes(data: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    let mut i = 0usize;
    std::iter::from_fn(move || {
        if i + 8 > data.len() {
            return None;
        }
        let mut size = be32(data, i) as usize;
        let mut hdr = 8;
        if size == 1 {
            if i + 16 > data.len() {
                return None;
            }
            size = be64(data, i + 8) as usize;
            hdr = 16;
        } else if size == 0 {
            size = data.len() - i;
        }
        if size < hdr || i.checked_add(size)? > data.len() {
            return None;
        }
        let item = (&data[i + 4..i + 8], &data[i + hdr..i + size]);
        i += size;
        Some(item)
    })
}

fn walk_boxes(data: &[u8], out: &mut MediaProbe, ctx: &mut TrakCtx) {
    for (typ, body) in boxes(data) {
        match typ {
            b"trak" => walk_boxes(body, out, &mut TrakCtx::default()),
            b"mdia" | b"minf" | b"stbl" => walk_boxes(body, out, ctx),
            b"mvhd" => out.duration = parse_mvhd(body),
            b"hdlr" if body.len() >= 12 => {
                ctx.is_video = &body[8..12] == b"vide";
                if &body[8..12] == b"soun" {
                    out.has_audio = Some(true);
                }
            }
            b"stsd" if ctx.is_video && out.video_codec.is_none() && body.len() > 8 => {
                // Only the first sample entry matters for our purposes.
                if let Some((codec, entry)) = boxes(&body[8..]).next() {
                    parse_visual_sample_entry(codec, entry, out);
                }
            }
            _ => {}
        }
    }
}

fn parse_mvhd(b: &[u8]) -> Option<f64> {
    let (timescale, duration) = match *b.first()? {
        1 if b.len() >= 32 => (be32(b, 20), be64(b, 24)),
        0 if b.len() >= 20 => (be32(b, 12), be32(b, 16) as u64),
        _ => return None,
    };
    (timescale > 0).then(|| duration as f64 / timescale as f64)
}

fn parse_visual_sample_entry(codec: &[u8], b: &[u8], out: &mut MediaProbe) {
    out.video_codec = Some(String::from_utf8_lossy(codec).trim().to_string());
    if matches!(codec, b"dvh1" | b"dvhe" | b"dvav" | b"dva1" | b"dav1") {
        out.dolby_vision = true;
    }
    if b.len() < 78 {
        return;
    }
    out.width = Some(be16(b, 24) as u32);
    out.height = Some(be16(b, 26) as u32);

    for (typ, c) in boxes(&b[78..]) {
        match typ {
            b"colr" if c.len() >= 10 => {
                let kind = &c[0..4];
                if kind == b"nclx" || kind == b"nclc" {
                    out.color = Some(ColorInfo {
                        primaries: Some(be16(c, 4)),
                        transfer: Some(be16(c, 6)),
                        matrix: Some(be16(c, 8)),
                        full_range: (kind == b"nclx" && c.len() >= 11).then(|| c[10] & 0x80 != 0),
                    });
                }
            }
            // HEVCDecoderConfigurationRecord: bitDepthLumaMinus8 lives in byte 17.
            b"hvcC" if c.len() >= 18 => out.bit_depth = Some((c[17] & 0x07) + 8),
            // AV1CodecConfigurationRecord: high_bitdepth / twelve_bit flags in byte 2.
            b"av1C" if c.len() >= 3 => {
                let high = c[2] & 0x40 != 0;
                let twelve = c[2] & 0x20 != 0;
                out.bit_depth = Some(if twelve { 12 } else if high { 10 } else { 8 });
            }
            // VPCodecConfigurationRecord (full box, version 1).
            b"vpcC" if c.len() >= 10 => {
                out.bit_depth = Some(c[6] >> 4);
                if out.color.is_none() {
                    out.color = Some(ColorInfo {
                        primaries: Some(c[7] as u16),
                        transfer: Some(c[8] as u16),
                        matrix: Some(c[9] as u16),
                        full_range: Some(c[6] & 0x01 != 0),
                    });
                }
            }
            b"avcC" if c.len() >= 2 && out.bit_depth.is_none() => {
                // High 10 / High 4:2:2 / High 4:4:4 profiles are usually 10-bit.
                out.bit_depth = Some(if matches!(c[1], 110 | 122 | 244) { 10 } else { 8 });
            }
            b"dvcC" | b"dvvC" | b"dvwC" => out.dolby_vision = true,
            b"mdcv" | b"clli" | b"SmDm" | b"CoLL" => out.hdr_metadata = true,
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Matroska / WebM (heuristic scan)
// ---------------------------------------------------------------------------

fn probe_matroska(f: &mut File, file_size: u64, out: &mut MediaProbe) -> std::io::Result<()> {
    f.seek(SeekFrom::Start(0))?;
    let mut buf = vec![0u8; file_size.min(MKV_SCAN_BYTES) as usize];
    let n = read_up_to(f, &mut buf)?;
    buf.truncate(n);

    for (needle, name) in [
        (&b"V_MPEGH/ISO/HEVC"[..], "hevc"),
        (b"V_MPEG4/ISO/AVC", "avc"),
        (b"V_AV1", "av1"),
        (b"V_VP9", "vp9"),
        (b"V_VP8", "vp8"),
    ] {
        if find(&buf, needle).is_some() {
            out.video_codec = Some(name.into());
            break;
        }
    }

    let uint = |id: [u8; 2]| ebml_small_uint(&buf, id);
    let color = ColorInfo {
        primaries: uint([0x55, 0xBB]),
        transfer: uint([0x55, 0xBA]),
        matrix: uint([0x55, 0xB1]),
        full_range: uint([0x55, 0xB9]).map(|r| r == 2),
    };
    if color != ColorInfo::default() {
        out.color = Some(color);
    }
    out.bit_depth = uint([0x55, 0xB2]).map(|b| b as u8);
    // MasteringMetadata / MaxCLL
    out.hdr_metadata = find(&buf, &[0x55, 0xD0]).is_some() || find(&buf, &[0x55, 0xBC, 0x81]).is_some();
    // Dolby Vision configuration in BlockAdditionMapping
    out.dolby_vision = find(&buf, b"dvcC").is_some() || find(&buf, b"dvvC").is_some();
    // Audio CodecIDs all start with "A_" (A_AAC, A_OPUS, A_VORBIS, ...): 0x86 id, small size, "A_".
    out.has_audio = Some(buf.windows(4).any(|w| w[0] == 0x86 && w[1] & 0x80 != 0 && &w[2..4] == b"A_"));
    Ok(())
}

/// Finds a 2-byte EBML id followed by a 1-byte size marker (0x81) and returns the value byte.
fn ebml_small_uint(buf: &[u8], id: [u8; 2]) -> Option<u16> {
    let needle = [id[0], id[1], 0x81];
    find(buf, &needle).and_then(|i| buf.get(i + 3)).map(|&v| v as u16)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn read_up_to(f: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match f.read(&mut buf[total..])? {
            0 => break,
            n => total += n,
        }
    }
    Ok(total)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn be16(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([b[i], b[i + 1]])
}
fn be32(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes(b[i..i + 4].try_into().unwrap())
}
fn be64(b: &[u8], i: usize) -> u64 {
    u64::from_be_bytes(b[i..i + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    /// Builds a minimal mp4 resembling an iPhone HDR (HLG + Dolby Vision) recording.
    fn iphone_like_mp4() -> Vec<u8> {
        let mut colr = b"nclx".to_vec();
        colr.extend_from_slice(&9u16.to_be_bytes()); // BT.2020
        colr.extend_from_slice(&18u16.to_be_bytes()); // HLG
        colr.extend_from_slice(&9u16.to_be_bytes());
        colr.push(0);

        let mut hvcc = vec![0u8; 23];
        hvcc[17] = 0xF8 | 2; // 10-bit

        let mut visual = vec![0u8; 78];
        visual[24..26].copy_from_slice(&1920u16.to_be_bytes());
        visual[26..28].copy_from_slice(&1080u16.to_be_bytes());
        visual.extend(bx(b"hvcC", &hvcc));
        visual.extend(bx(b"colr", &colr));
        visual.extend(bx(b"dvvC", &[0u8; 24]));

        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(bx(b"hvc1", &visual));

        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 12]);

        let mut mvhd = vec![0u8; 20];
        mvhd[12..16].copy_from_slice(&600u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&3000u32.to_be_bytes());

        let stbl = bx(b"stbl", &bx(b"stsd", &stsd));
        let minf = bx(b"minf", &stbl);
        let mut mdia_body = bx(b"hdlr", &hdlr);
        mdia_body.extend(minf);
        let trak = bx(b"trak", &bx(b"mdia", &mdia_body));
        let mut moov_body = bx(b"mvhd", &mvhd);
        moov_body.extend(trak);

        let mut file = bx(b"ftyp", b"qt  \0\0\0\0qt  ");
        file.extend(bx(b"mdat", &[0u8; 16]));
        file.extend(bx(b"moov", &moov_body));
        file
    }

    #[test]
    fn detects_hlg_dolby_vision_mov() {
        let dir = std::env::temp_dir().join(format!("vcb-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hdr.mov");
        std::fs::write(&path, iphone_like_mp4()).unwrap();

        let p = probe(&path).unwrap();
        assert_eq!(p.container, "mov");
        assert_eq!(p.video_codec.as_deref(), Some("hvc1"));
        assert_eq!((p.width, p.height), (Some(1920), Some(1080)));
        assert_eq!(p.duration, Some(5.0));
        assert_eq!(p.bit_depth, Some(10));
        assert!(p.dolby_vision);
        assert_eq!(p.color.as_ref().unwrap().transfer, Some(18));
        assert_eq!(p.hdr, Some(HdrKind::Hlg));
        // The synthetic file only has a video track.
        assert_eq!(p.has_audio, Some(false));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sdr_is_not_hdr() {
        let p = MediaProbe {
            color: Some(ColorInfo { transfer: Some(1), ..Default::default() }),
            bit_depth: Some(8),
            ..Default::default()
        };
        assert_eq!(classify_hdr(&p), None);
    }
}
