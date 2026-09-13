import AppKit
import Foundation

@main
struct InstallMediaSniperCompanion {
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)
        do {
            let didInstall = try install()
            if !didInstall {
                Foundation.exit(2)
            }
        } catch {
            MediaSniperInstall.alert(
                title: "Media Sniper could not be installed",
                message: "Nothing outside Media Sniper's application-support folders was changed. \(error.localizedDescription)",
                primary: "Close",
                style: .critical
            )
            Foundation.exit(1)
        }
    }

    private static func install() throws -> Bool {
        let manager = FileManager.default
        guard let resources = Bundle.main.resourceURL else {
            throw InstallError.missingResource("installer resources")
        }
        let payload = resources.appendingPathComponent("payload", isDirectory: true)
        let hostSource = payload.appendingPathComponent("native-host/media-sniper-companion")
        let manifestTemplate = payload.appendingPathComponent(
            "native-host/com.grej.media_sniper.json.in"
        )
        let extensionSource = payload.appendingPathComponent("extension", isDirectory: true)
        let toolsSource = payload.appendingPathComponent("managed-tools", isDirectory: true)
        let releaseMetadata = payload.appendingPathComponent("release.json")
        for required in [hostSource, manifestTemplate, extensionSource, toolsSource, releaseMetadata] {
            guard manager.fileExists(atPath: required.path) else {
                throw InstallError.missingResource(required.lastPathComponent)
            }
        }

        let prompt = MediaSniperInstall.alert(
            title: "Install Media Sniper Companion?",
            message: "This installs the Media Sniper extension, its native helper, and verified media tools for your macOS account. Brave is the primary browser; Chrome is also supported.",
            primary: "Install",
            secondary: "Cancel"
        )
        guard prompt == .alertFirstButtonReturn else { return false }

        let root = MediaSniperInstall.applicationSupport
        let isUpgrade = manager.fileExists(
            atPath: root.appendingPathComponent("install-receipt.json").path
        )
        try MediaSniperInstall.createPrivateDirectory(root)
        let staging = root.appendingPathComponent(".install-\(UUID().uuidString)", isDirectory: true)
        try MediaSniperInstall.createPrivateDirectory(staging)
        defer { try? manager.removeItem(at: staging) }

        let stagedHost = staging.appendingPathComponent("media-sniper-companion")
        try manager.copyItem(at: hostSource, to: stagedHost)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stagedHost.path)
        let hostDestination = root.appendingPathComponent(
            "Companion/host/media-sniper-companion"
        )

        let stagedExtension = staging.appendingPathComponent("Extension", isDirectory: true)
        try manager.copyItem(at: extensionSource, to: stagedExtension)
        let stagedExtensionVersion = try MediaSniperInstall.verifyCompanionExtension(
            at: stagedExtension
        )
        let extensionDestination = root.appendingPathComponent("Extension", isDirectory: true)

        let toolPayload = toolsSource.appendingPathComponent("payload", isDirectory: true)
        let toolManifestData = try Data(contentsOf: toolsSource.appendingPathComponent("manifest.json"))
        let toolSignature = try String(
            contentsOf: toolsSource.appendingPathComponent("manifest.sig"),
            encoding: .utf8
        )
        try MediaSniperInstall.verifyReleaseSignature(
            document: toolManifestData,
            signatureText: toolSignature
        )
        let releaseMetadataData = try Data(
            contentsOf: toolsSource.appendingPathComponent("release-metadata.json")
        )
        let releaseMetadataSignature = try String(
            contentsOf: toolsSource.appendingPathComponent("release-metadata.sig"),
            encoding: .utf8
        )
        try MediaSniperInstall.verifyReleaseSignature(
            document: releaseMetadataData,
            signatureText: releaseMetadataSignature
        )
        let toolReleaseID = try MediaSniperInstall.verifyToolPayload(
            root: toolPayload,
            manifestData: toolManifestData
        )
        try preflightTools(root: toolPayload)
        let releaseMetadataObject = try JSONSerialization.jsonObject(
            with: releaseMetadataData
        ) as? [String: Any]
        let compatibility = releaseMetadataObject?["compatibility"] as? [String: Any]
        let solver = compatibility?["youtubeSolver"] as? [String: Any]
        let jsRuntime = compatibility?["jsRuntime"] as? [String: Any]
        guard
            releaseMetadataObject?["releaseId"] as? String == toolReleaseID,
            compatibility?["ytDlpDistribution"] as? String == "official-executable",
            solver?["provider"] as? String == "yt-dlp-ejs",
            solver?["embedded"] as? Bool == true,
            solver?["remoteComponentsAllowed"] as? Bool == false,
            solver?["version"] as? String != nil,
            jsRuntime?["name"] as? String == "deno",
            let denoVersion = jsRuntime?["version"] as? String,
            version(denoVersion, isAtLeast: "2.3.0")
        else {
            throw InstallError.invalidToolRelease
        }

        let managedToolsRoot = root.appendingPathComponent("tools", isDirectory: true)
        let releasesRoot = managedToolsRoot.appendingPathComponent("versions", isDirectory: true)
        let stagedTools = staging.appendingPathComponent(toolReleaseID, isDirectory: true)
        try manager.copyItem(at: toolPayload, to: stagedTools)
        let toolReleaseDestination = releasesRoot.appendingPathComponent(
            toolReleaseID,
            isDirectory: true
        )

        let activeVersionURL = managedToolsRoot.appendingPathComponent("active-version")
        var previousRelease: String?
        if let activeVersion = try? String(contentsOf: activeVersionURL, encoding: .utf8) {
            let candidate = activeVersion.trimmingCharacters(in: .whitespacesAndNewlines)
            if candidate.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil {
                previousRelease = candidate
            }
        }
        let activation: [String: Any?] = [
            "schemaVersion": 1,
            "activeRelease": toolReleaseID,
            "previousRelease": previousRelease == toolReleaseID ? nil : previousRelease,
        ]
        let activationObject = activation.compactMapValues { $0 }
        let activationData = try JSONSerialization.data(
            withJSONObject: activationObject,
            options: [.prettyPrinted, .sortedKeys]
        )

        let templateData = try Data(contentsOf: manifestTemplate)
        guard var parsed = try JSONSerialization.jsonObject(with: templateData) as? [String: Any]
        else { throw InstallError.invalidManifest }
        parsed["path"] = hostDestination.path
        let manifestData = try JSONSerialization.data(
            withJSONObject: parsed,
            options: [.prettyPrinted, .sortedKeys]
        )
        guard
            parsed["name"] as? String == MediaSniperInstall.hostName,
            parsed["path"] as? String == hostDestination.path,
            parsed["allowed_origins"] as? [String] == [MediaSniperInstall.extensionOrigin]
        else { throw InstallError.invalidManifest }

        let installerRelease = try JSONSerialization.jsonObject(
            with: Data(contentsOf: releaseMetadata)
        ) as? [String: Any]
        guard
            let releaseVersion = installerRelease?["releaseVersion"] as? String,
            let extensionVersion = installerRelease?["extensionVersion"] as? String,
            let companionVersion = installerRelease?["companionVersion"] as? String,
            let bundleVersion = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String,
            releaseVersion == extensionVersion,
            extensionVersion == companionVersion,
            extensionVersion == stagedExtensionVersion,
            releaseVersion == bundleVersion,
            installerRelease?["extensionId"] as? String ==
                "dioapemglpdpmfmoekckbpenmpdgkofp",
            installerRelease?["toolReleaseId"] as? String == toolReleaseID,
            installerRelease?["target"] as? String == releaseMetadataObject?["target"] as? String
        else { throw InstallError.invalidToolRelease }

        // All signatures, hashes, identities, metadata, and tool health checks
        // have passed. Only now replace installed components and activation
        // markers.
        try MediaSniperInstall.replaceItem(at: hostDestination, with: stagedHost)
        try MediaSniperInstall.replaceItem(at: extensionDestination, with: stagedExtension)
        try MediaSniperInstall.createPrivateDirectory(releasesRoot)
        try MediaSniperInstall.replaceItem(at: toolReleaseDestination, with: stagedTools)

        let manifestsRoot = managedToolsRoot.appendingPathComponent("manifests", isDirectory: true)
        try MediaSniperInstall.createPrivateDirectory(manifestsRoot)
        try toolManifestData.write(
            to: manifestsRoot.appendingPathComponent("\(toolReleaseID).json"),
            options: .atomic
        )
        try toolSignature.write(
            to: manifestsRoot.appendingPathComponent("\(toolReleaseID).sig"),
            atomically: true,
            encoding: .utf8
        )
        if let previousRelease, previousRelease != toolReleaseID {
            try "\(previousRelease)\n".write(
                to: managedToolsRoot.appendingPathComponent("previous-version"),
                atomically: true,
                encoding: .utf8
            )
        }
        try "\(toolReleaseID)\n".write(
            to: activeVersionURL,
            atomically: true,
            encoding: .utf8
        )
        try activationData.write(
            to: managedToolsRoot.appendingPathComponent("activation.json"),
            options: .atomic
        )

        for directory in MediaSniperInstall.browserManifestDirectories {
            try MediaSniperInstall.createPrivateDirectory(directory)
            let destination = directory.appendingPathComponent("com.grej.media_sniper.json")
            let temporary = staging.appendingPathComponent(UUID().uuidString)
            try manifestData.write(to: temporary, options: .atomic)
            try MediaSniperInstall.replaceItem(at: destination, with: temporary)
        }

        let receiptDestination = root.appendingPathComponent("install-receipt.json")
        let browsers = MediaSniperInstall.browserApplications
            .filter { manager.fileExists(atPath: $0.path) }
            .map(\.name)
        let receipt: [String: Any] = [
            "schemaVersion": 2,
            "extensionOrigin": MediaSniperInstall.extensionOrigin,
            "registeredBrowsers": browsers,
            "releaseVersion": releaseVersion,
            "extensionVersion": extensionVersion,
            "companionVersion": companionVersion,
            "toolReleaseId": toolReleaseID,
            "installedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        let receiptData = try JSONSerialization.data(
            withJSONObject: receipt,
            options: [.prettyPrinted, .sortedKeys]
        )
        try receiptData.write(to: receiptDestination, options: [.atomic, .completeFileProtection])

        if isUpgrade {
            MediaSniperInstall.alert(
                title: "Media Sniper updated",
                message: "Return to the Media Sniper update prompt and choose Check installation. Media Sniper will verify this release and finish the update for you.",
                primary: "Done"
            )
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([extensionDestination])
            MediaSniperInstall.alert(
                title: "Files installed",
                message: "The Media Sniper extension folder is selected in Finder. Open Brave's Extensions page, enable Developer mode, choose Load unpacked, and select that folder. This one-time step is not needed for routine updates.",
                primary: "Done"
            )
        }
        return true
    }

    private static func preflightTools(root: URL) throws {
        let checks: [(String, [String])] = [
            ("yt-dlp", ["--ignore-config", "--no-remote-components", "--version"]),
            ("ffmpeg", ["-version"]),
            ("ffprobe", ["-version"]),
            ("deno", ["--version"]),
        ]
        for (name, arguments) in checks {
            let process = Process()
            process.executableURL = root.appendingPathComponent("bin/\(name)")
            process.arguments = arguments
            process.environment = [:]
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = Pipe()
            process.standardError = Pipe()
            let finished = DispatchSemaphore(value: 0)
            process.terminationHandler = { _ in finished.signal() }
            try process.run()
            guard finished.wait(timeout: .now() + 15) == .success else {
                process.terminate()
                throw InstallError.toolHealth(name)
            }
            guard process.terminationStatus == 0 else { throw InstallError.toolHealth(name) }
        }
    }

    private static func version(_ actual: String, isAtLeast minimum: String) -> Bool {
        let parse = { (value: String) in
            value.split(separator: ".").prefix(3).compactMap { Int($0) }
        }
        let left = parse(actual)
        let right = parse(minimum)
        guard left.count >= 2, right.count >= 2 else { return false }
        for index in 0..<3 {
            let difference = (index < left.count ? left[index] : 0) -
                (index < right.count ? right[index] : 0)
            if difference != 0 { return difference > 0 }
        }
        return true
    }
}

private enum InstallError: LocalizedError {
    case missingResource(String)
    case invalidManifest
    case invalidToolRelease
    case toolHealth(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let name): return "The signed package is missing \(name)."
        case .invalidManifest: return "The native host registration is invalid."
        case .invalidToolRelease: return "The managed tool release metadata is invalid."
        case .toolHealth(let name): return "The managed \(name) health check failed."
        }
    }
}
