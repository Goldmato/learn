import json
import tempfile
import unittest
import wave
from pathlib import Path

from scripts.breeze_voice_presets import (
    count_valid_pairs,
    find_style_instructions,
    manifest_preset,
    preset_id,
    resolve_style_instructions,
    save_style_instructions,
    style_instruction_field_values,
    validate_presets,
)


class BreezeVoicePresetTests(unittest.TestCase):
    def test_counts_only_matching_six_digit_valid_wav_transcript_pairs(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            wavs = root / "wavs"
            transcripts = root / "transcripts"
            wavs.mkdir()
            transcripts.mkdir()
            with wave.open(str(wavs / "123456.wav"), "wb") as audio_file:
                audio_file.setnchannels(1)
                audio_file.setsampwidth(2)
                audio_file.setframerate(24_000)
                audio_file.writeframes(b"\0\0" * 100)
            (transcripts / "123456-transcript.txt").write_text("Valid reference.", encoding="utf-8")
            (wavs / "654321.wav").write_bytes(b"not a wav file")
            (transcripts / "654321-transcript.txt").write_text("Invalid WAV.", encoding="utf-8")
            (wavs / "not-six-digits.wav").write_bytes(b"x" * 128)

            self.assertEqual(count_valid_pairs(str(wavs), str(transcripts)), 1)

    def test_normalizes_ids_and_rejects_duplicate_or_unusable_presets(self):
        self.assertEqual(preset_id("Warm Narrator!"), "warm-narrator")
        with self.assertRaisesRegex(ValueError, "duplicate id"):
            validate_presets([
                {"name": "Warm Narrator", "wavsDirectory": "missing", "transcriptsDirectory": "missing"},
                {"name": "Warm Narrator!", "wavsDirectory": "missing", "transcriptsDirectory": "missing"},
            ])

    def test_rejects_standard_as_a_clone_preset(self):
        with self.assertRaisesRegex(ValueError, "reserved"):
            validate_presets([
                {"name": "Standard", "wavsDirectory": "missing", "transcriptsDirectory": "missing"},
            ])

    def test_discovers_parses_and_stores_transcript_style_instructions_for_its_voice(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            transcripts = root / "transcripts"
            transcripts.mkdir()
            style_path = transcripts / "style-instructions.json"
            instructions = {"voice": "Warm and measured", "pace": "deliberate"}
            style_path.write_text(json.dumps(instructions), encoding="utf-8")

            self.assertEqual(find_style_instructions(str(transcripts)), style_path.resolve())
            stored_path, stored_instructions = resolve_style_instructions(str(transcripts))
            self.assertEqual(stored_path, str(style_path.resolve()))
            self.assertEqual(stored_instructions, instructions)
            manifest_entry = manifest_preset({
                "name": "Warm Narrator",
                "wavsDirectory": str(root / "wavs"),
                "transcriptsDirectory": str(transcripts),
            })
            self.assertEqual(manifest_entry["styleInstructionsPath"], str(style_path.resolve()))
            self.assertEqual(manifest_entry["styleInstructions"], instructions)

    def test_style_instructions_are_parsed_from_the_associated_transcript_folder(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            transcripts = root / "transcripts"
            transcripts.mkdir()
            style_path = transcripts / "style-instructions.json"
            style_path.write_text('["calm", "measured"]', encoding="utf-8")
            stored_path, stored_instructions = resolve_style_instructions(str(transcripts))
            self.assertEqual(stored_path, str(style_path.resolve()))
            self.assertEqual(stored_instructions, ["calm", "measured"])

            style_path.write_text('{"voice": "Warm"}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "from the selected transcript folder"):
                resolve_style_instructions(str(transcripts), str(root / "style-instructions.json"))

    def test_style_builder_saves_editable_fields_and_preserves_custom_json_fields(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            transcripts = Path(temporary_directory) / "transcripts"
            transcripts.mkdir()
            style_path = transcripts / "style-instructions.json"
            style_path.write_text(
                json.dumps({"voice": "Bright", "custom": {"reference": "Keep this"}}),
                encoding="utf-8",
            )
            fields = style_instruction_field_values(json.loads(style_path.read_text(encoding="utf-8")))
            self.assertEqual(fields["voice"], "Bright")

            saved_path = save_style_instructions(
                str(transcripts),
                {"voice": "Warm and resonant", "pace": "Measured with short pauses"},
            )

            self.assertEqual(saved_path, style_path)
            self.assertEqual(json.loads(style_path.read_text(encoding="utf-8")), {
                "voice": "Warm and resonant",
                "custom": {"reference": "Keep this"},
                "pace": "Measured with short pauses",
            })


if __name__ == "__main__":
    unittest.main()
