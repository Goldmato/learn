import json
import tempfile
import unittest
from pathlib import Path

from scripts.configure_paths import empty_config, load_config, save_config


class ConfigurePathsTests(unittest.TestCase):
    def test_round_trips_local_path_settings(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "local-paths.json"
            config = empty_config()
            config["audioCppRoot"] = str(Path(temporary_directory) / "audio")
            config["breezeVoice"] = {
                "name": "Configured Narrator",
                "wavsDirectory": str(Path(temporary_directory) / "wavs"),
                "transcriptsDirectory": str(Path(temporary_directory) / "transcripts"),
            }

            save_config(config_path, config)

            self.assertEqual(load_config(config_path), config)

    def test_rejects_malformed_local_path_settings(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "local-paths.json"
            config_path.write_text(json.dumps({"version": 2}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "version 1"):
                load_config(config_path)


if __name__ == "__main__":
    unittest.main()
