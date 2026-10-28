import tempfile
import unittest
import wave
from pathlib import Path

from scripts.breeze_voice_presets import count_valid_pairs, preset_id, validate_presets


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


if __name__ == "__main__":
    unittest.main()
