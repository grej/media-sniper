#!/usr/bin/env python3
"""Publish the exact GitHub release packages; never rebuild or replace a file."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

OWNER = "gjennings"
PACKAGE = "media-sniper-installer"
REPOSITORY = "grej/media-sniper"
API = "https://api.anaconda.org"
SUBDIRS = {"osx-arm64", "osx-64"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run_json(arguments):
    return json.loads(subprocess.check_output(arguments, text=True))


def inspect_packages(directory, version):
    packages = []
    for path in sorted(directory.glob("*.conda")):
        require(re.fullmatch(rf"{PACKAGE}-{re.escape(version)}-[A-Za-z0-9_]+\.conda", path.name),
                "Unexpected package filename")
        checksum = path.with_name(path.name + ".sha256").read_text().split()
        with path.open("rb") as package_file:
            digest = hashlib.file_digest(package_file, "sha256").hexdigest()
        require(checksum == [digest, path.name], f"Checksum mismatch: {path.name}")
        index = run_json(["rattler-build", "package", "inspect", "--json", str(path)])["index"]
        require(index["name"] == PACKAGE and index["version"] == version and
                index["subdir"] in SUBDIRS and not index.get("depends"),
                f"Unexpected package metadata: {path.name}")
        packages.append({"path": path, "sha256": digest, "subdir": index["subdir"],
                         "basename": f"{index['subdir']}/{path.name}"})
    require(len(packages) == 2 and {p["subdir"] for p in packages} == SUBDIRS,
            "The release must include exactly one installer for each Mac architecture")
    return packages


def package_metadata():
    try:
        with urlopen(f"{API}/package/{OWNER}/{PACKAGE}", timeout=45) as response:
            metadata = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return {"files": []}
        raise
    require(metadata.get("full_name") == f"{OWNER}/{PACKAGE}" and
            metadata.get("owner", {}).get("login") == OWNER, "Unexpected Anaconda package owner")
    return metadata


def existing_file(metadata, package, version):
    matches = [file for file in metadata["files"] if file.get("basename") == package["basename"]
               and file.get("version") == version]
    require(len(matches) <= 1, "Duplicate package records")
    if not matches:
        return None
    result = matches[0]
    require(result.get("sha256") == package["sha256"] and result.get("owner") == OWNER and
            result.get("attrs", {}).get("subdir") == package["subdir"],
            f"Existing file differs; refusing to overwrite {package['basename']}")
    return result


def wait_for_files(packages, version, labels):
    for attempt in range(12):
        metadata = package_metadata()
        files = [existing_file(metadata, package, version) for package in packages]
        if all(file and labels.intersection(file.get("labels", [])) for file in files):
            return metadata
        if attempt < 11:
            time.sleep(10)
    raise RuntimeError(f"Published files are not visible with labels {sorted(labels)}")


def add_main_label(package, version, token):
    body = json.dumps({"package": PACKAGE, "version": version,
                       "basename": package["basename"]}).encode()
    request = Request(f"{API}/channels/{OWNER}/main", data=body, method="POST",
                      headers={"Content-Type": "application/json", "Authorization": f"token {token}"})
    with urlopen(request, timeout=45) as response:
        require(response.status == 201, "Anaconda did not confirm label promotion")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "publish", "check"])
    parser.add_argument("tag")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    require(re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", args.tag),
            "A stable release tag such as v1.13.0 is required")
    version = args.tag[1:]
    if args.action == "prepare":
        release = run_json(["gh", "api", f"repos/{REPOSITORY}/releases/tags/{args.tag}"])
        require(not release["draft"] and not release["prerelease"], "Release must be public and stable")
        args.directory.mkdir(parents=True, exist_ok=True)
        subprocess.run(["gh", "release", "download", args.tag, "--repo", REPOSITORY,
                        "--pattern", f"{PACKAGE}-{version}-*.conda*", "--dir", str(args.directory)], check=True)
        packages = inspect_packages(args.directory, version)
        assets = {asset["name"]: asset for asset in release["assets"]}
        for package in packages:
            asset = assets[package["path"].name]
            require(asset["state"] == "uploaded" and asset["digest"] == "sha256:" + package["sha256"],
                    "GitHub asset digest does not match the downloaded package")
        print(f"Verified both GitHub installer packages for {version}", flush=True)
        return

    packages = inspect_packages(args.directory, version)
    if args.action == "publish":
        token = os.environ.get("ANACONDA_API_KEY", "")
        require(bool(token), "Set the ANACONDA_TOKEN repository secret before publishing")
        metadata = package_metadata()
        for package in packages:
            if not existing_file(metadata, package, version):
                subprocess.run(["rattler-build", "upload", "anaconda", "--owner", OWNER,
                                "--channel", "candidate", str(package["path"])], check=True)
        metadata = wait_for_files(packages, version, {"candidate", "main"})
        for package in packages:
            if "main" not in existing_file(metadata, package, version).get("labels", []):
                add_main_label(package, version, token)
        print(f"Promoted both verified {version} installers to main", flush=True)

    metadata = wait_for_files(packages, version, {"main"})
    require(metadata["latest_version"] == version, "Published version is not Anaconda's latest release")
    print(f"Public Anaconda metadata confirms {version} on both Mac architectures", flush=True)


if __name__ == "__main__":
    main()
