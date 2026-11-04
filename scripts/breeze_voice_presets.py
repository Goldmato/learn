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
STYLE_INSTRUCTIONS_NAME = "style-instructions.json"
MAX_STYLE_INSTRUCTIONS_BYTES = 128 * 1024
STYLE_INSTRUCTION_FIELDS = (
    ("voice", "Voice", "Voice qualities, such as warm, bright, or resonant."),
    ("delivery", "Delivery", "How it should be spoken, such as conversational or theatrical."),
    ("pace", "Pace", "Speed and pauses, such as measured with clear pauses."),
    ("emotion", "Emotion", "The overall feeling, such as calm confidence."),
    ("pronunciation", "Pronunciation", "Names or words that need special pronunciation."),
)


def find_style_instructions(transcripts_directory: str) -> Path | None:
    candidate = Path(transcripts_directory).expanduser() / STYLE_INSTRUCTIONS_NAME
    try:
        if not candidate.exists():
            return None
        return candidate
    except OSError as error:
        raise ValueError(f"Could not inspect style instructions: {error}") from error


def resolve_style_instructions(
    transcripts_directory: str,
    selected_path: str | None = None,
) -> tuple[str | None, Any]:
    transcripts_path = Path(transcripts_directory).expanduser().resolve()
    candidate = Path(selected_path).expanduser() if selected_path else None
    if candidate is None or not str(selected_path).strip():
        candidate = find_style_instructions(str(transcripts_path))
        if candidate is None:
            return None, None
    try:
        if candidate.name != STYLE_INSTRUCTIONS_NAME or candidate.parent.resolve() != transcripts_path:
            raise ValueError(
                f"Choose {STYLE_INSTRUCTIONS_NAME} from the selected transcript folder."
            )
        if candidate.is_symlink():
            raise ValueError(f"Style instructions must be a regular file: {candidate}")
        resolved = candidate.resolve(strict=True)
        if resolved.parent != transcripts_path or resolved.name != STYLE_INSTRUCTIONS_NAME:
            raise ValueError(
                f"Choose {STYLE_INSTRUCTIONS_NAME} from the selected transcript folder."
            )
        stat = resolved.stat()
        if not resolved.is_file():
            raise ValueError(f"Style instructions must be a regular file: {resolved}")
        if stat.st_size > MAX_STYLE_INSTRUCTIONS_BYTES:
            raise ValueError(
                f"Style instructions exceed the {MAX_STYLE_INSTRUCTIONS_BYTES}-byte limit: {resolved}"
            )
        instructions = json.loads(resolved.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not load style instructions from {candidate}: {error}") from error
    return str(resolved), instructions


def manifest_preset(preset: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": preset_id(preset["name"]),
        "name": preset["name"].strip(),
        "wavsDirectory": str(Path(preset["wavsDirectory"]).expanduser().resolve()),
        "transcriptsDirectory": str(Path(preset["transcriptsDirectory"]).expanduser().resolve()),
    }
    style_path, style_instructions = resolve_style_instructions(
        preset["transcriptsDirectory"],
        preset.get("styleInstructionsPath"),
    )
    if style_path is not None:
        entry["styleInstructionsPath"] = style_path
        entry["styleInstructions"] = style_instructions
    return entry


def save_style_instructions(transcripts_directory: str, values: dict[str, str]) -> Path:
    directory = Path(transcripts_directory).expanduser().resolve()
    if not directory.is_dir():
        raise ValueError(f"Transcript folder is unavailable: {directory}")
    target = directory / STYLE_INSTRUCTIONS_NAME
    if target.is_symlink():
        raise ValueError(f"Style instructions must be a regular file: {target}")
    existing: dict[str, Any] = {}
    if target.exists():
        _, loaded = resolve_style_instructions(str(directory), str(target))
        if not isinstance(loaded, dict):
            raise ValueError(f"Style instructions must be a JSON object to edit: {target}")
        existing = loaded

    for key, _label, _hint in STYLE_INSTRUCTION_FIELDS:
        value = values.get(key, "").strip()
        if value:
            existing[key] = value
        else:
            existing.pop(key, None)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{STYLE_INSTRUCTIONS_NAME}.",
        suffix=".tmp",
        dir=directory,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as temporary_file:
            json.dump(existing, temporary_file, ensure_ascii=False, indent=2)
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
    return target


def style_instruction_field_values(instructions: Any) -> dict[str, str]:
    if not isinstance(instructions, dict):
        raise ValueError("Style instructions must be a JSON object to edit.")
    return {
        key: value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        for key, _label, _hint in STYLE_INSTRUCTION_FIELDS
        if (value := instructions.get(key)) is not None
    }


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


def validate_presets(presets: list[dict[str, Any]]) -> None:
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
        resolve_style_instructions(
            preset["transcriptsDirectory"],
            preset.get("styleInstructionsPath"),
        )


class PresetDialog(tk.Toplevel):
    def __init__(self, parent: tk.Misc, preset: dict[str, Any] | None = None) -> None:
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
        default_style_path = find_style_instructions(preset["transcriptsDirectory"]) if preset["transcriptsDirectory"] else None
        self.style_instructions_var = tk.StringVar(
            value=preset.get("styleInstructionsPath", str(default_style_path) if default_style_path else "")
        )

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
        ttk.Button(body, text="Browse…", command=self._browse_transcripts).grid(row=2, column=2, padx=(8, 0), pady=5)
        ttk.Label(body, text="Style instructions").grid(row=3, column=0, sticky="w", padx=(0, 8), pady=5)
        ttk.Entry(body, textvariable=self.style_instructions_var).grid(row=3, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=self._browse_style_instructions).grid(row=3, column=2, padx=(8, 0), pady=5)
        ttk.Button(body, text="Build / edit…", command=self._edit_style_instructions).grid(row=3, column=3, padx=(8, 0), pady=5)
        ttk.Label(
            body,
            text="Pairs use <six-digit-id>.wav and <six-digit-id>-transcript.txt. A style-instructions.json in the transcript folder is loaded into this preset.",
            wraplength=500,
        ).grid(row=4, column=0, columnspan=4, sticky="w", pady=(8, 12))

        buttons = ttk.Frame(body)
        buttons.grid(row=5, column=0, columnspan=4, sticky="e")
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

    def _browse_transcripts(self) -> None:
        self._browse(self.transcripts_var)
        candidate = find_style_instructions(self.transcripts_var.get())
        self.style_instructions_var.set(str(candidate) if candidate else "")

    def _browse_style_instructions(self) -> None:
        transcripts_directory = self.transcripts_var.get().strip()
        selected = filedialog.askopenfilename(
            parent=self,
            title="Choose transcript style instructions",
            initialdir=transcripts_directory or str(Path.home()),
            initialfile=STYLE_INSTRUCTIONS_NAME,
            filetypes=(("Style instructions", STYLE_INSTRUCTIONS_NAME), ("JSON files", "*.json")),
        )
        if selected:
            self.style_instructions_var.set(selected)

    def _edit_style_instructions(self) -> None:
        transcripts_directory = self.transcripts_var.get().strip()
        if not transcripts_directory:
            messagebox.showerror("Choose transcript folder", "Choose the voice's transcript folder first.", parent=self)
            return
        try:
            target = Path(transcripts_directory).expanduser().resolve() / STYLE_INSTRUCTIONS_NAME
            existing: Any = {}
            if target.exists():
                _, existing = resolve_style_instructions(transcripts_directory, str(target))
            initial_values = style_instruction_field_values(existing)
        except (OSError, UnicodeError, ValueError) as error:
            messagebox.showerror("Could not load style instructions", str(error), parent=self)
            return
        StyleInstructionsDialog(self, transcripts_directory, initial_values, self._style_instructions_saved)

    def _style_instructions_saved(self, target: Path) -> None:
        self.style_instructions_var.set(str(target))

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
            "styleInstructionsPath": self.style_instructions_var.get().strip(),
        }
        if not self.result["name"] or not self.result["wavsDirectory"] or not self.result["transcriptsDirectory"]:
            messagebox.showerror("Incomplete preset", "Enter a name and choose both folders.", parent=self)
            return
        self.destroy()


class StyleInstructionsDialog(tk.Toplevel):
    def __init__(
        self,
        parent: tk.Misc,
        transcripts_directory: str,
        initial_values: dict[str, str],
        on_saved: Any,
    ) -> None:
        super().__init__(parent)
        self.transcripts_directory = transcripts_directory
        self.on_saved = on_saved
        self.fields: dict[str, tk.Text] = {}
        self.title("Build voice style instructions")
        self.resizable(True, True)
        self.transient(parent)
        self.grab_set()

        body = ttk.Frame(self, padding=12)
        body.grid(sticky="nsew")
        body.columnconfigure(1, weight=1)
        ttk.Label(
            body,
            text="Fill in any fields you want. Blank fields are omitted. Saved as style-instructions.json in this voice's transcript folder.",
            wraplength=640,
        ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
        for row, (key, label, hint) in enumerate(STYLE_INSTRUCTION_FIELDS, start=1):
            ttk.Label(body, text=label).grid(row=row, column=0, sticky="nw", padx=(0, 10), pady=4)
            field = tk.Text(body, width=58, height=2, wrap="word")
            field.grid(row=row, column=1, sticky="ew", pady=4)
            field.insert("1.0", initial_values.get(key, ""))
            field.configure(undo=True)
            ttk.Label(body, text=hint, wraplength=240).grid(row=row, column=2, sticky="w", padx=(10, 0))
            self.fields[key] = field

        buttons = ttk.Frame(body)
        buttons.grid(row=1 + len(STYLE_INSTRUCTION_FIELDS), column=0, columnspan=3, sticky="e", pady=(10, 0))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(buttons, text="Save style file", command=self._save).pack(side="right")
        self.bind("<Escape>", lambda _event: self.destroy())
        self.geometry("960x420")

    def _save(self) -> None:
        values = {key: field.get("1.0", "end-1c") for key, field in self.fields.items()}
        try:
            target = save_style_instructions(self.transcripts_directory, values)
        except (OSError, UnicodeError, ValueError) as error:
            messagebox.showerror("Could not save style instructions", str(error), parent=self)
            return
        self.on_saved(target)
        self.destroy()


class VoicePresetEditor:
    def __init__(self, root: tk.Tk, manifest_path: Path) -> None:
        self.root = root
        self.manifest_path = manifest_path
        self.presets: list[dict[str, Any]] = []
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
                loaded: list[dict[str, Any]] = []
                for item in data["presets"]:
                    if not isinstance(item, dict) or not all(
                        isinstance(item.get(key), str) for key in ("name", "wavsDirectory", "transcriptsDirectory")
                    ):
                        raise ValueError("Each preset must have a name, WAV directory, and transcript directory.")
                    preset: dict[str, Any] = {
                        "name": item["name"],
                        "wavsDirectory": item["wavsDirectory"],
                        "transcriptsDirectory": item["transcriptsDirectory"],
                    }
                    if "styleInstructionsPath" in item:
                        if not isinstance(item["styleInstructionsPath"], str):
                            raise ValueError("A preset styleInstructionsPath must be a string.")
                        if "styleInstructions" not in item:
                            raise ValueError("A preset with styleInstructionsPath must have styleInstructions.")
                        preset["styleInstructionsPath"] = item["styleInstructionsPath"]
                    elif "styleInstructions" in item:
                        raise ValueError("A preset with styleInstructions must have a styleInstructionsPath.")
                    loaded.append(preset)
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
                "presets": [manifest_preset(preset) for preset in self.presets],
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
