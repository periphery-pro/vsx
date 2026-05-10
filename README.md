# Periphery for VS Code

Find unused Swift code in your Swift packages. Automatically scans after package builds by the Swift extension, and reports results in the Problems pane.

## Requirements

- [Periphery](https://periphery.pro) installed and on your `$PATH`
- The Swift extension for VS Code, available on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sswg.swift-lang) and [Open VSX Registry](https://open-vsx.org/extension/swiftlang/swift-vscode).

## Usage

1. Open a Swift package in VS Code.
2. Build it using the Swift extension.
3. Periphery scans automatically after a successful build and reports unused code in the **Problems** pane.

You can also run a scan manually from the command palette: **Periphery: Scan for Unused Code**.

To clear results: **Periphery: Clear Results**.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `periphery.executablePath` | `periphery` | Path to the `periphery` binary |
| `periphery.scanOnBuild` | `true` | Automatically scan after a successful Swift build |
