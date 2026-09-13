import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-conda-release.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def file(version, label="main"):
    return {"version": version, "owner": publisher.OWNER, "labels": [label],
            "attrs": {"subdir": "osx-arm64"}}


class PublicationMetadataTests(unittest.TestCase):
    def test_advances_only_latest_attribute_after_promotion(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(publisher, "urlopen", return_value=response) as send:
            publisher.refresh_latest_version({"files": [file("1.13.0"), file("1.13.1"),
                                                         file("1.14.0", "candidate")]},
                                             "1.13.1", "fixture-token")
        request = send.call_args.args[0]
        self.assertEqual(request.method, "PATCH")
        self.assertEqual(request.full_url, "https://api.anaconda.org/package/gjennings/media-sniper-installer")
        self.assertEqual(json.loads(request.data), {"public_attrs": {"latest_version": "1.13.1"}})

    def test_does_not_downgrade_a_newer_main_release(self):
        with patch.object(publisher, "urlopen") as send:
            with self.assertRaisesRegex(ValueError, "newer public release"):
                publisher.refresh_latest_version({"files": [file("1.13.1"), file("1.14.0")]},
                                                 "1.13.1", "fixture-token")
        send.assert_not_called()

    def test_waits_for_latest_marker_as_well_as_files(self):
        record = file("1.13.1")
        with patch.object(publisher, "package_metadata", side_effect=[
            {"files": [record], "latest_version": "1.13.0"},
            {"files": [record], "latest_version": "1.13.1"},
        ]), patch.object(publisher, "existing_file", return_value=record), \
                patch.object(publisher.time, "sleep") as sleep:
            result = publisher.wait_for_files([{}], "1.13.1", {"main"}, latest=True)
        self.assertEqual(result["latest_version"], "1.13.1")
        sleep.assert_called_once_with(10)


if __name__ == "__main__":
    unittest.main()
