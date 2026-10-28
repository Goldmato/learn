#!/usr/bin/env python3
"""Edit the named Breeze voice-clone presets used by this Pi workspace."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any


WAV_NAME = re.compile(r"^(\d{6})(?:[-_.][^.]*)?\.wav$", re.IGNORECASE)
MAX_TRANSCRIPT_BYTES = 128 * 1024


def count_valid_pairs(wavs_directory: str, transcripts_directory: str) -> int:
    wavs_path = Path(wavs_directory).expanduser()
    transcripts_path = Path(transcripts_directory).expanduser()
    if not wavs_path.is_dir() or not transcripts_path.is_dir():
        return 0

    valid_pairs = 0
    try:
        for wav_path in wavs_path.iterdir():
            if not wav_path.is_file() or wav_path.is_symlink():
                continue
            match = WAV_NAME.fullmatch(wav_path.name)
            if match is None or wav_path.stat().st_size <= 44:
                continue
            with wav_path.open("rb") as wav_file:
                header = wav_file.read(12)
            if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
                continue

            transcript_path = transcripts_path / f"{match.group(1)}-transcript.txt"
            if not transcript_path.is_file() or transcript_path.is_symlink():
                continue
            if transcript_path.stat().st_size == 0 or transcript_path.stat().st_size > MAX_TRANSCRIPT_BYTES:
                continue
            if transcript_path.read_text(encoding="utf-8-sig").strip():
                valid_pairs += 1
    except OSError as error:
        raise ValueError(f"Could not inspect a voice-reference folder: {error}") from error
    except UnicodeError as error:
        raise ValueError(f"A matching transcript is not valid UTF-8: {error}") from error
    return valid_pairs


def preset_id(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.strip().lower())).strip("-")


def validate_presets(presets: list[dict[str, str]]) -> None:
    seen_ids: set[str] = set()
    for preset in presets:
        name = preset["name"].strip()
        identifier = preset_id(name)
        if not name or not identifier:
            raise ValueError("Each preset needs a name containing letters or numbers.")
        if identifier == "standard":
            raise ValueError('"Standard" is reserved for the built-in non-clone voice.')
        if identifier in seen_ids:
            raise ValueError(f"Preset names must be unique; {name!r} produces duplicate id {identifier!r}.")
        seen_ids.add(identifier)
    for preset in presets:
        name = preset["name"].strip()
        count = count_valid_pairs(preset["wavsDirectory"], preset["transcriptsDirectory"])
        if count == 0:
            raise ValueError(
                f"{name!r} has no valid matching six-digit WAV and "
                "{id}-transcript.txt pairs in its selected folders."
            )


class PresetDialog(tk.Toplevel):
    def __init__(self, parent: tk.Misc, preset: dict[str, str] | None = None) -> None:
        super().__init__(parent)
        self.title("Voice preset")
        self.resizable(True, False)
        self.result: dict[str, str] | None = None
        self.transient(parent)
        self.grab_set()

        preset = preset or {"name": "", "wavsDirectory": "", "transcriptsDirectory": ""}
        self.name_var = tk.StringVar(value=preset["name"])
        self.wavs_var = tk.StringVar(value=preset["wavsDirectory"])
        self.transcripts_var = tk.StringVar(value=preset["transcriptsDirectory"])

        body = ttk.Frame(self, padding=12)
        body.grid(sticky="nsew")
        body.columnconfigure(1, weight=1)
        ttk.Label(body, text="Preset name").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=5)
        ttk.Entry(body, textvariable=self.name_var, width=48).grid(row=0, column=1, columnspan=2, sticky="ew", pady=5)
        ttk.Label(body, text="WAV folder").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=5)
        ttk.Entry(body, textvariable=self.wavs_var).grid(row=1, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse(self.wavs_var)).grid(row=1, column=2, padx=(8, 0), pady=5)
        ttk.Label(body, text="Transcript folder").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=5)
        ttk.Entry(body, textvariable=self.transcripts_var).grid(row=2, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse(self.transcripts_var)).grid(row=2, column=2, padx=(8, 0), pady=5)
        ttk.Label(
            body,
            text="Pairs use <six-digit-id>.wav and <six-digit-id>-transcript.txt.",
            wraplength=500,
        ).grid(row=3, column=0, columnspan=3, sticky="w", pady=(8, 12))

        buttons = ttk.Frame(body)
        buttons.grid(row=4, column=0, columnspan=3, sticky="e")
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(buttons, text="Add preset" if preset is None else "Save preset", command=self._save).pack(side="right")
        self.bind("<Return>", self._on_return)
        self.bind("<Escape>", self._on_escape)
        self.wait_visibility()
        self.focus_set()

    def _browse(self, variable: tk.StringVar) -> None:
        selected = filedialog.askdirectory(parent=self, initialdir=variable.get() or str(Path.home()))
        if selected:
            variable.set(selected)

    def _on_return(self, event: tk.Event) -> str:
        if event.keysym == "Return":
            self._save()
        return "break"

    def _on_escape(self, event: tk.Event) -> str:
        if event.keysym == "Escape":
            self.destroy()
        return "break"

    def _save(self) -> None:
        self.result = {
            "name": self.name_var.get().strip(),
            "wavsDirectory": self.wavs_var.get().strip(),
            "transcriptsDirectory": self.transcripts_var.get().strip(),
        }
        if not self.result["name"] or not self.result["wavsDirectory"] or not self.result["transcriptsDirectory"]:
            messagebox.showerror("Incomplete preset", "Enter a name and choose both folders.", parent=self)
            return
        self.destroy()


class VoicePresetEditor:
    def __init__(self, root: tk.Tk, manifest_path: Path) -> None:
        self.root = root
        self.manifest_path = manifest_path
        self.presets: list[dict[str, str]] = []
        self.load_error: str | None = None
        self.root.title("Breeze Voice Presets")
        self.root.geometry("940x420")
        self.root.minsize(720, 320)

        frame = ttk.Frame(root, padding=12)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(2, weight=1)

        ttk.Label(frame, text="Manifest file").grid(row=0, column=0, sticky="w")
        manifest_row = ttk.Frame(frame)
        manifest_row.grid(row=1, column=0, sticky="ew", pady=(4, 10))
        manifest_row.columnconfigure(0, weight=1)
        self.path_var = tk.StringVar(value=str(manifest_path))
        ttk.Entry(manifest_row, textvariable=self.path_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(manifest_row, text="Browse…", command=self._browse_manifest).grid(row=0, column=1, padx=(8, 0))

        table_frame = ttk.Frame(frame)
        table_frame.grid(row=2, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)
        self.table = ttk.Treeview(table_frame, columns=("name", "pairs", "wavs", "transcripts"), show="headings", selectmode="browse")
        for column, heading, width in (
            ("name", "Preset", 150),
            ("pairs", "Valid pairs", 90),
            ("wavs", "WAV folder", 300),
            ("transcripts", "Transcript folder", 300),
        ):
            self.table.heading(column, text=heading)
            self.table.column(column, width=width, minwidth=80, anchor="w")
        self.table.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(table_frame, orient="vertical", command=self.table.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.table.configure(yscrollcommand=scrollbar.set)
        self.table.bind("<Double-1>", self._edit_on_double_click)

        controls = ttk.Frame(frame)
        controls.grid(row=3, column=0, sticky="ew", pady=(10, 4))
        ttk.Button(controls, text="Add preset…", command=self._add).pack(side="left")
        ttk.Button(controls, text="Edit…", command=self._edit).pack(side="left", padx=6)
        ttk.Button(controls, text="Remove", command=self._remove).pack(side="left")
        self.save_button = ttk.Button(controls, text="Save manifest", command=self._save)
        self.save_button.pack(side="right")
        ttk.Label(
            frame,
            text="The standard non-clone Breeze voice is always available and is not stored in this file.",
            wraplength=900,
        ).grid(row=4, column=0, sticky="w", pady=(6, 0))

        self._load()

    def _manifest_target(self) -> Path:
        text = self.path_var.get().strip()
        if not text:
            raise ValueError("Choose a manifest file path.")
        return Path(text).expanduser().resolve()

    def _browse_manifest(self) -> None:
        current = self.path_var.get().strip()
        selected = filedialog.asksaveasfilename(
            parent=self.root,
            title="Choose Breeze voice manifest",
            initialdir=str(Path(current).parent if current else self.manifest_path.parent),
            initialfile=Path(current).name if current else self.manifest_path.name,
            defaultextension=".json",
            filetypes=(("JSON files", "*.json"), ("All files", "*.*")),
        )
        if selected:
            self.path_var.set(selected)
            self._load()

    def _load(self) -> None:
        try:
            target = self._manifest_target()
            if target.exists():
                data: Any = json.loads(target.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("presets"), list):
                    raise ValueError("Expected a version 1 JSON object with a presets array.")
                loaded: list[dict[str, str]] = []
                for item in data["presets"]:
                    if not isinstance(item, dict) or not all(
                        isinstance(item.get(key), str) for key in ("name", "wavsDirectory", "transcriptsDirectory")
                    ):
                        raise ValueError("Each preset must have a name, WAV directory, and transcript directory.")
                    loaded.append({
                        "name": item["name"],
                        "wavsDirectory": item["wavsDirectory"],
                        "transcriptsDirectory": item["transcriptsDirectory"],
                    })
                self.presets = loaded
            else:
                self.presets = []
            self.load_error = None
            self.save_button.state(["!disabled"])
            self._refresh()
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            self.load_error = str(error)
            self.save_button.state(["disabled"])
            messagebox.showerror("Could not load manifest", str(error), parent=self.root)

    def _refresh(self) -> None:
        self.table.delete(*self.table.get_children())
        for index, preset in enumerate(self.presets):
            try:
                count = count_valid_pairs(preset["wavsDirectory"], preset["transcriptsDirectory"])
                pair_label = str(count)
            except (OSError, UnicodeError, ValueError) as error:
                pair_label = f"Error: {error}"
            self.table.insert(
                "",
                "end",
                iid=str(index),
                values=(preset["name"], pair_label, preset["wavsDirectory"], preset["transcriptsDirectory"]),
            )

    def _selected_index(self) -> int | None:
        selection = self.table.selection()
        return int(selection[0]) if selection else None

    def _edit_on_double_click(self, event: tk.Event) -> None:
        if event.widget is self.table:
            self._edit()

    def _add(self) -> None:
        dialog = PresetDialog(self.root)
        self.root.wait_window(dialog)
        if dialog.result is not None:
            self.presets.append(dialog.result)
            self._refresh()

    def _edit(self) -> None:
        index = self._selected_index()
        if index is None:
            messagebox.showinfo("Select a preset", "Choose a preset to edit.", parent=self.root)
            return
        dialog = PresetDialog(self.root, self.presets[index])
        self.root.wait_window(dialog)
        if dialog.result is not None:
            self.presets[index] = dialog.result
            self._refresh()

    def _remove(self) -> None:
        index = self._selected_index()
        if index is None:
            messagebox.showinfo("Select a preset", "Choose a preset to remove.", parent=self.root)
            return
        if messagebox.askyesno("Remove voice preset", f"Remove {self.presets[index]['name']!r}?", parent=self.root):
            del self.presets[index]
            self._refresh()

    def _save(self) -> None:
        if self.load_error is not None:
            messagebox.showerror("Manifest not loaded", "Load a valid manifest before saving to this path.", parent=self.root)
            return
        try:
            validate_presets(self.presets)
            target = self._manifest_target()
            target.parent.mkdir(parents=True, exist_ok=True)
            manifest = {
                "version": 1,
                "presets": [
                    {
                        "id": preset_id(preset["name"]),
                        "name": preset["name"].strip(),
                        "wavsDirectory": str(Path(preset["wavsDirectory"]).expanduser().resolve()),
                        "transcriptsDirectory": str(Path(preset["transcriptsDirectory"]).expanduser().resolve()),
                    }
                    for preset in self.presets
                ],
            }
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as temporary_file:
                    json.dump(manifest, temporary_file, ensure_ascii=False, indent=2)
                    temporary_file.write("\n")
                    temporary_file.flush()
                    os.fsync(temporary_file.fileno())
                os.replace(temporary_name, target)
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
            self.path_var.set(str(target))
            self._refresh()
            messagebox.showinfo("Manifest saved", f"Saved {len(self.presets)} voice preset(s) to:\n{target}", parent=self.root)
        except (OSError, UnicodeError, ValueError) as error:
            messagebox.showerror("Could not save manifest", str(error), parent=self.root)


def main() -> None:
    default_manifest = Path(__file__).resolve().parents[1] / "breeze-voices.json"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=default_manifest, help="Manifest to edit")
    args = parser.parse_args()

    root = tk.Tk()
    VoicePresetEditor(root, args.manifest.expanduser().resolve())
    root.mainloop()


if __name__ == "__main__":
    main()
