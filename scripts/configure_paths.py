#!/usr/bin/env python3
"""Configure machine-local paths used by the Pi learning workspace."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any


def empty_config() -> dict[str, Any]:
    return {
        "version": 1,
        "audioCppRoot": "",
        "cudaRootDirectory": "",
        "mdLogDemoOutput": "",
        "breezeVoice": {
            "name": "",
            "wavsDirectory": "",
            "transcriptsDirectory": "",
        },
    }


def load_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return empty_config()
    try:
        data: Any = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not load path settings from {config_path}: {error}") from error
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("Path settings must be a version 1 JSON object.")

    config = empty_config()
    for key in ("audioCppRoot", "cudaRootDirectory", "mdLogDemoOutput"):
        value = data.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"Path setting {key} must be a string.")
        config[key] = value
    voice = data.get("breezeVoice", {})
    if not isinstance(voice, dict):
        raise ValueError("The breezeVoice setting must be an object.")
    for key in ("name", "wavsDirectory", "transcriptsDirectory"):
        value = voice.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"Path setting breezeVoice.{key} must be a string.")
        config["breezeVoice"][key] = value
    return config


def save_config(config_path: Path, config: dict[str, Any]) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{config_path.name}.",
        suffix=".tmp",
        dir=config_path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as config_file:
            json.dump(config, config_file, ensure_ascii=False, indent=2)
            config_file.write("\n")
            config_file.flush()
            os.fsync(config_file.fileno())
        os.replace(temporary_name, config_path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


class PathConfigEditor:
    def __init__(self, root: tk.Tk, config_path: Path) -> None:
        self.root = root
        self.config_path = config_path
        self.root.title("Pi Local Path Configuration")
        self.root.geometry("860x440")
        self.root.minsize(700, 380)

        try:
            config = load_config(config_path)
        except ValueError as error:
            messagebox.showerror("Could not load path settings", str(error), parent=root)
            root.destroy()
            return

        self.audio_cpp_var = tk.StringVar(value=config["audioCppRoot"])
        self.cuda_var = tk.StringVar(value=config["cudaRootDirectory"])
        self.demo_var = tk.StringVar(value=config["mdLogDemoOutput"])
        self.voice_name_var = tk.StringVar(value=config["breezeVoice"]["name"])
        self.wavs_var = tk.StringVar(value=config["breezeVoice"]["wavsDirectory"])
        self.transcripts_var = tk.StringVar(value=config["breezeVoice"]["transcriptsDirectory"])

        body = ttk.Frame(root, padding=14)
        body.pack(fill="both", expand=True)
        body.columnconfigure(1, weight=1)
        ttk.Label(body, text="audio.cpp install folder").grid(row=0, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(body, textvariable=self.audio_cpp_var).grid(row=0, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse_directory(self.audio_cpp_var)).grid(
            row=0, column=2, padx=(8, 0), pady=5
        )
        ttk.Label(body, text="CUDA root folder (optional)").grid(row=1, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(body, textvariable=self.cuda_var).grid(row=1, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse_directory(self.cuda_var)).grid(
            row=1, column=2, padx=(8, 0), pady=5
        )
        ttk.Label(body, text="md-log demo output file").grid(row=2, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(body, textvariable=self.demo_var).grid(row=2, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=self._browse_demo_output).grid(
            row=2, column=2, padx=(8, 0), pady=5
        )

        ttk.Separator(body).grid(row=3, column=0, columnspan=3, sticky="ew", pady=12)
        ttk.Label(body, text="Default Breeze clone preset").grid(row=4, column=0, sticky="w", pady=5)
        ttk.Entry(body, textvariable=self.voice_name_var).grid(row=4, column=1, columnspan=2, sticky="ew", pady=5)
        ttk.Label(body, text="Voice WAV folder").grid(row=5, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(body, textvariable=self.wavs_var).grid(row=5, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse_directory(self.wavs_var)).grid(
            row=5, column=2, padx=(8, 0), pady=5
        )
        ttk.Label(body, text="Voice transcript folder").grid(row=6, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(body, textvariable=self.transcripts_var).grid(row=6, column=1, sticky="ew", pady=5)
        ttk.Button(body, text="Browse…", command=lambda: self._browse_directory(self.transcripts_var)).grid(
            row=6, column=2, padx=(8, 0), pady=5
        )
        ttk.Label(
            body,
            text="Settings are saved locally to local-paths.json and are excluded from version control. Leave all clone fields blank to disable the default clone preset.",
            wraplength=800,
        ).grid(row=7, column=0, columnspan=3, sticky="w", pady=(12, 8))
        ttk.Button(body, text="Save settings", command=self._save).grid(row=8, column=2, sticky="e", pady=(4, 0))

    def _browse_directory(self, variable: tk.StringVar) -> None:
        selected = filedialog.askdirectory(
            parent=self.root,
            initialdir=variable.get().strip() or str(Path.home()),
        )
        if selected:
            variable.set(selected)

    def _browse_demo_output(self) -> None:
        current = self.demo_var.get().strip()
        selected = filedialog.asksaveasfilename(
            parent=self.root,
            title="Choose md-log demo output",
            initialdir=str(Path(current).parent) if current else str(Path.home()),
            initialfile=Path(current).name if current else "md-log-transcript-demo.md",
            defaultextension=".md",
            filetypes=(("Markdown files", "*.md"), ("All files", "*.*")),
        )
        if selected:
            self.demo_var.set(selected)

    def _save(self) -> None:
        voice_name = self.voice_name_var.get().strip()
        wavs_directory = self.wavs_var.get().strip()
        transcripts_directory = self.transcripts_var.get().strip()
        if any((voice_name, wavs_directory, transcripts_directory)) and not all(
            (voice_name, wavs_directory, transcripts_directory)
        ):
            messagebox.showerror(
                "Incomplete Breeze preset",
                "Enter a preset name and choose both voice folders, or clear all three fields.",
                parent=self.root,
            )
            return

        config = {
            "version": 1,
            "audioCppRoot": self.audio_cpp_var.get().strip(),
            "cudaRootDirectory": self.cuda_var.get().strip(),
            "mdLogDemoOutput": self.demo_var.get().strip(),
            "breezeVoice": {
                "name": voice_name,
                "wavsDirectory": wavs_directory,
                "transcriptsDirectory": transcripts_directory,
            },
        }
        try:
            save_config(self.config_path, config)
        except OSError as error:
            messagebox.showerror("Could not save path settings", str(error), parent=self.root)
            return
        messagebox.showinfo("Path settings saved", f"Saved local settings to:\n{self.config_path}", parent=self.root)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    default_config = Path(__file__).resolve().parents[1] / "local-paths.json"
    parser.add_argument("--config", type=Path, default=default_config, help="Local path configuration file")
    args = parser.parse_args()

    root = tk.Tk()
    PathConfigEditor(root, args.config.expanduser().resolve())
    root.mainloop()


if __name__ == "__main__":
    main()
