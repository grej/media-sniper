import AppKit
import Foundation

@main
struct UninstallMediaSniperCompanion {
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)
        let response = MediaSniperInstall.alert(
            title: "Uninstall Media Sniper Companion?",
            message: "This removes the native helper, managed media tools, and browser registration from your macOS account. Files you downloaded are not removed.",
            primary: "Uninstall",
            secondary: "Cancel",
            style: .warning
        )
        guard response == .alertFirstButtonReturn else { return }

        do {
            try uninstall()
            MediaSniperInstall.alert(
                title: "Media Sniper Companion removed",
                message: "Reload Brave's Extensions page to finish disconnecting the helper. Downloaded media remains in your Downloads folder."
            )
        } catch {
            MediaSniperInstall.alert(
                title: "Uninstall could not finish",
                message: error.localizedDescription,
                primary: "Close",
                style: .critical
            )
            Foundation.exit(1)
        }
    }

    private static func uninstall() throws {
        let manager = FileManager.default
        for directory in MediaSniperInstall.browserManifestDirectories {
            let manifest = directory.appendingPathComponent("com.grej.media_sniper.json")
            if manager.fileExists(atPath: manifest.path) {
                guard MediaSniperInstall.hostManifestIsOurs(manifest) else {
                    throw UninstallError.foreignManifest(manifest.path)
                }
                try manager.removeItem(at: manifest)
            }
        }

        let root = MediaSniperInstall.applicationSupport
        if manager.fileExists(atPath: root.path) {
            try manager.removeItem(at: root)
        }
    }
}

private enum UninstallError: LocalizedError {
    case foreignManifest(String)

    var errorDescription: String? {
        switch self {
        case .foreignManifest(let path):
            return "A native-host file at \(path) does not belong to this Media Sniper release, so it was left untouched."
        }
    }
}
