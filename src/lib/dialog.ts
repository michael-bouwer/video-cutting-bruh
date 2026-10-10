import { useStore, type DialogButton } from "../store";

/**
 * Shows an in-app modal and resolves with the id of the clicked button.
 * In-app (rather than native) dialogs look and behave the same on every OS.
 */
export function ask(title: string, message: string, buttons: DialogButton[], cancelId: string): Promise<string> {
  return new Promise((resolve) => {
    // Only one dialog at a time: a newer one cancels an older one.
    useStore.getState().dialog?.resolve(useStore.getState().dialog!.cancelId);
    useStore.setState({
      dialog: {
        title,
        message,
        buttons,
        cancelId,
        resolve: (id) => {
          useStore.setState({ dialog: null });
          resolve(id);
        },
      },
    });
  });
}

/** "Save changes?" prompt. Resolves to "save", "discard" or "cancel". */
export function confirmUnsaved(action: string): Promise<"save" | "discard" | "cancel"> {
  const name = projectName(useStore.getState().projectPath);
  return ask(
    "Save changes?",
    `Do you want to save the changes to "${name}" before ${action}? Your changes will be lost if you don't save them.`,
    [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Don't save", kind: "danger" },
      { id: "save", label: "Save", kind: "primary" },
    ],
    "cancel",
  ) as Promise<"save" | "discard" | "cancel">;
}

export function projectName(path: string | null): string {
  if (!path) return "Untitled";
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.vcbproj$/i, "");
}
