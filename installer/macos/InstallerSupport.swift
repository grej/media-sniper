import AppKit
import CryptoKit
import Foundation

enum MediaSniperInstall {
    static let hostName = "com.grej.media_sniper"
    static let extensionOrigin = "chrome-extension://dioapemglpdpmfmoekckbpenmpdgkofp/"
    static let toolReleasePublicKey = "44XFJjYK5JVQyBlZvr8IUwu7w7++++pCMOjJQqQhLik="

    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    static var applicationSupport: URL {
        home.appendingPathComponent("Library/Application Support/Media Sniper", isDirectory: true)
    }
    static var browserManifestDirectories: [URL] {
        [
            home.appendingPathComponent(
                "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                isDirectory: true
            ),
            home.appendingPathComponent(
                "Library/Application Support/Google/Chrome/NativeMessagingHosts",
                isDirectory: true
            ),
        ]
    }
    static var browserApplications: [(name: String, path: String)] {
        [
            ("Brave", "/Applications/Brave Browser.app"),
            ("Chrome", "/Applications/Google Chrome.app"),
        ]
    }

    @discardableResult
    static func alert(
        title: String,
        message: String,
        primary: String = "OK",
        secondary: String? = nil,
        style: NSAlert.Style = .informational
    ) -> NSApplication.ModalResponse {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.addButton(withTitle: primary)
        if let secondary { alert.addButton(withTitle: secondary) }
        return alert.runModal()
    }

    static func createPrivateDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: url.path
        )
    }

    static func replaceItem(at destination: URL, with source: URL) throws {
        let manager = FileManager.default
        try createPrivateDirectory(destination.deletingLastPathComponent())
        if manager.fileExists(atPath: destination.path) {
            _ = try manager.replaceItemAt(destination, withItemAt: source)
        } else {
            try manager.moveItem(at: source, to: destination)
        }
    }

    static func hostManifestIsOurs(_ url: URL) -> Bool {
        guard
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["name"] as? String == hostName,
            let origins = object["allowed_origins"] as? [String],
            origins == [extensionOrigin]
        else { return false }
        return true
    }

    static func verifyReleaseSignature(document: Data, signatureText: String) throws {
        guard
            let keyData = Data(base64Encoded: toolReleasePublicKey),
            let signature = Data(base64Encoded: signatureText.trimmingCharacters(in: .whitespacesAndNewlines))
        else { throw ReleaseVerificationError.invalidSignature }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyData)
        guard key.isValidSignature(signature, for: document) else {
            throw ReleaseVerificationError.invalidSignature
        }
    }

    static func verifyCompanionExtension(at root: URL) throws -> String {
        let data = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
        guard
            let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let keyText = manifest["key"] as? String,
            let keyData = Data(base64Encoded: keyText),
            let permissions = manifest["permissions"] as? [String],
            permissions.contains("nativeMessaging"),
            permissions.contains("alarms"),
            let optionalPermissions = manifest["optional_permissions"] as? [String],
            optionalPermissions == ["cookies"],
            let version = manifest["version"] as? String,
            version.range(of: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", options: .regularExpression) != nil
        else { throw ReleaseVerificationError.invalidExtension }
        let digest = SHA256.hash(data: keyData)
        let alphabet = Array("abcdefghijklmnop")
        let identifier = digest.prefix(16).flatMap { byte in
            [alphabet[Int(byte >> 4)], alphabet[Int(byte & 0x0f)]]
        }
        guard String(identifier) == "dioapemglpdpmfmoekckbpenmpdgkofp" else {
            throw ReleaseVerificationError.invalidExtension
        }
        return version
    }

    static func verifyToolPayload(root: URL, manifestData: Data) throws -> String {
        guard
            let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
            Set(manifest.keys) == Set(["version", "files"]),
            let version = manifest["version"] as? String,
            !version.isEmpty,
            version.count <= 64,
            version.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
            let files = manifest["files"] as? [[String: Any]],
            !files.isEmpty,
            files.count <= 64
        else { throw ReleaseVerificationError.invalidManifest }

        var expected = Set<String>()
        for file in files {
            guard
                Set(file.keys) == Set(["path", "sha256"]),
                let relativePath = file["path"] as? String,
                !relativePath.isEmpty,
                relativePath.count <= 256,
                !relativePath.hasPrefix("/"),
                !relativePath.split(separator: "/").contains(".."),
                let expectedHash = file["sha256"] as? String,
                expectedHash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
                expected.insert(relativePath).inserted
            else { throw ReleaseVerificationError.invalidManifest }
            let fileURL = root.appendingPathComponent(relativePath)
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw ReleaseVerificationError.invalidPayload
            }
            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            let actualHash = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard actualHash.caseInsensitiveCompare(expectedHash) == .orderedSame else {
                throw ReleaseVerificationError.invalidPayload
            }
        }

        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]
        ) else { throw ReleaseVerificationError.invalidPayload }
        var actual = Set<String>()
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { throw ReleaseVerificationError.invalidPayload }
            if values.isRegularFile == true {
                let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
                guard fileURL.path.hasPrefix(prefix) else {
                    throw ReleaseVerificationError.invalidPayload
                }
                actual.insert(String(fileURL.path.dropFirst(prefix.count)))
            }
        }
        guard actual == expected else { throw ReleaseVerificationError.invalidPayload }
        return version
    }
}

enum ReleaseVerificationError: LocalizedError {
    case invalidSignature
    case invalidManifest
    case invalidPayload
    case invalidExtension

    var errorDescription: String? {
        switch self {
        case .invalidSignature: return "A managed-tool release signature is invalid."
        case .invalidManifest: return "The managed-tool manifest is invalid."
        case .invalidPayload: return "A managed-tool payload hash or path is invalid."
        case .invalidExtension: return "The companion extension identity or permissions are invalid."
        }
    }
}
