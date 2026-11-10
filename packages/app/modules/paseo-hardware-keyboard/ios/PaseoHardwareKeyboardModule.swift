import ExpoModulesCore
import UIKit
import GameController

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let hardwareShortcutEventName = "onHardwareKeyboardShortcut"

private weak var activeModule: PaseoHardwareKeyboardModule?
private var isHardwareSubmitEnabled = false
private var overlayKeys: Set<String> = []
private var shortcuts: [HardwareShortcut] = []
private var isCapturingShortcut = false

fileprivate struct HardwareShortcut: Record {
  @Field var key: String = ""
  @Field var code: String = ""
  @Field var ctrlKey: Bool = false
  @Field var metaKey: Bool = false
  @Field var altKey: Bool = false
  @Field var shiftKey: Bool = false

  var modifiers: UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    if ctrlKey { flags.insert(.control) }
    if metaKey { flags.insert(.command) }
    if altKey { flags.insert(.alternate) }
    if shiftKey { flags.insert(.shift) }
    return flags
  }

  var input: String {
    switch code {
    case "ArrowLeft": return UIKeyCommand.inputLeftArrow
    case "ArrowRight": return UIKeyCommand.inputRightArrow
    case "ArrowUp": return UIKeyCommand.inputUpArrow
    case "ArrowDown": return UIKeyCommand.inputDownArrow
    case "Escape": return UIKeyCommand.inputEscape
    case "Enter": return "\r"
    case "Tab": return "\t"
    case "Backspace": return "\u{8}"
    case "Delete": return UIKeyCommand.inputDelete
    case "Home": return UIKeyCommand.inputHome
    case "End": return UIKeyCommand.inputEnd
    case "PageUp": return UIKeyCommand.inputPageUp
    case "PageDown": return UIKeyCommand.inputPageDown
    case "Insert": return "\u{F727}"
    default:
      if code.hasPrefix("F"), let number = Int(code.dropFirst()), (1...12).contains(number) {
        let keys = [UIKeyCommand.f1, UIKeyCommand.f2, UIKeyCommand.f3, UIKeyCommand.f4,
                    UIKeyCommand.f5, UIKeyCommand.f6, UIKeyCommand.f7, UIKeyCommand.f8,
                    UIKeyCommand.f9, UIKeyCommand.f10, UIKeyCommand.f11, UIKeyCommand.f12]
        return keys[number - 1]
      }
      return key
    }
  }

  var event: [String: Any] {
    return ["key": key, "code": code, "ctrlKey": ctrlKey, "metaKey": metaKey,
            "altKey": altKey, "shiftKey": shiftKey, "repeat": false]
  }
}

/// UIKit spells non-character keys as sentinel input strings rather than as the
/// character they would type. JS sends the DOM `code` and the mapping lives
/// here, so the constants stay in the one place that owns UIKit vocabulary.
private let namedKeyInputs: [String: String] = [
  "Escape": UIKeyCommand.inputEscape,
  "ArrowUp": UIKeyCommand.inputUpArrow,
  "ArrowDown": UIKeyCommand.inputDownArrow,
  "Enter": "\r",
]

/// Whether the first responder is mid-IME-composition.
///
/// A committing key has to stay out of the way while a CJK candidate is being
/// chosen: Enter confirms the candidate, and consuming it as a key command
/// would submit the half-composed text instead.
private func isComposingText() -> Bool {
  guard let responder = UIResponder.paseoCurrentFirstResponder as? UITextInput else {
    return false
  }
  return responder.markedTextRange != nil
}

public class PaseoHardwareKeyboardModule: Module {
  private var keyboardObservers: [NSObjectProtocol] = []
  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, hardwareShortcutEventName, "onHardwareKeyboardPresenceChanged")

    OnCreate {
      activeModule = self
      for name in [Notification.Name.GCKeyboardDidConnect, Notification.Name.GCKeyboardDidDisconnect] {
        self.keyboardObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.sendEvent("onHardwareKeyboardPresenceChanged", [:])
        })
      }
    }

    Function("getHardwareKeyboardPresent") { GCKeyboard.coalesced != nil }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        guard activeModule === self else { return }
        isHardwareSubmitEnabled = enabled
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    Function("setHardwareKeyboardShortcuts") { (commands: [HardwareShortcut], capturing: Bool) in
      DispatchQueue.main.async {
        guard activeModule === self else { return }
        shortcuts = commands
        isCapturingShortcut = capturing
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    Function("setOverlayKeys") { (keys: [String]) in
      DispatchQueue.main.async {
        overlayKeys = Set(keys).intersection(["Enter", "ArrowUp", "ArrowDown"])
        UIMenuSystem.main.setNeedsRebuild()
      }
    }

    OnDestroy {
      self.keyboardObservers.forEach(NotificationCenter.default.removeObserver)
      self.keyboardObservers = []
      if activeModule === self {
        activeModule = nil
        isHardwareSubmitEnabled = false
        overlayKeys = []
        shortcuts = []
        isCapturingShortcut = false
        UIMenuSystem.main.setNeedsRebuild()
      }
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitShortcut(_ shortcut: HardwareShortcut) {
    sendEvent(hardwareShortcutEventName, shortcut.event)
  }

  fileprivate func emitHardwareKeyboardPress(_ press: UIPress, isRepeat: Bool) {
    guard let key = press.key else { return }
    let code = hardwareKeyCode(key)
    let characters = key.characters
    let named = namedKeyInputs.first { $0.value == characters }?.key
    let keyName: String
    if code.hasPrefix("Meta") { keyName = "Meta" }
    else if code.hasPrefix("Control") { keyName = "Control" }
    else if code.hasPrefix("Shift") { keyName = "Shift" }
    else if code.hasPrefix("Alt") { keyName = "Alt" }
    else { keyName = named ?? (characters.isEmpty ? code : characters) }
    guard !code.isEmpty else { return }
    sendEvent(hardwareShortcutEventName, [
      "key": keyName,
      "code": code,
      "altKey": key.modifierFlags.contains(.alternate),
      "ctrlKey": key.modifierFlags.contains(.control),
      "metaKey": key.modifierFlags.contains(.command),
      "shiftKey": key.modifierFlags.contains(.shift),
      "repeat": isRepeat,
      "isComposing": isComposingText(),
      "phase": press.phase == .ended || press.phase == .cancelled ? "up" : "down",
    ])
  }
}

public final class PaseoHardwareKeyboardWindow: UIWindow {
  private var pressedCodes: Set<Int> = []
  public static func observing(_ original: UIWindow) -> UIWindow {
    if original is PaseoHardwareKeyboardWindow { return original }
    guard let scene = original.windowScene else { return original }
    let observed = PaseoHardwareKeyboardWindow(windowScene: scene)
    observed.windowLevel = original.windowLevel
    observed.backgroundColor = original.backgroundColor
    let controller = original.rootViewController
    original.rootViewController = nil
    original.isHidden = true
    observed.rootViewController = controller
    observed.makeKeyAndVisible()
    return observed
  }

  public override func sendEvent(_ event: UIEvent) {
    if let event = event as? UIPressesEvent {
      for press in event.allPresses where press.phase == .began || press.phase == .ended || press.phase == .cancelled {
        guard let key = press.key else { continue }
        let raw = Int(key.keyCode.rawValue)
        let isRepeat = press.phase == .began && pressedCodes.contains(raw)
        if press.phase == .began { pressedCodes.insert(raw) }
        else { pressedCodes.remove(raw) }
        activeModule?.emitHardwareKeyboardPress(press, isRepeat: isRepeat)
      }
    }
    super.sendEvent(event)
  }
  public override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    let configuredShortcuts = isCapturingShortcut
      ? shortcuts
      : shortcuts.filter { !($0.modifiers.isEmpty && overlayKeys.contains($0.code)) }
    commands.append(contentsOf: configuredShortcuts.map(makeConfiguredShortcutCommand))
    if !isCapturingShortcut && isHardwareSubmitEnabled && !isPlainReturnClaimed && !isComposingText()
      && UIDevice.current.userInterfaceIdiom == .pad
    {
      commands.append(makeSubmitCommand())
    }
    if !isCapturingShortcut && !isComposingText() {
      commands.append(contentsOf: overlayKeys.compactMap(makeShortcutCommand))
    }
    return commands
  }

  /// Whether something registered has already asked for an unmodified Return.
  ///
  /// The submit command is registered for as long as the composer holds focus,
  /// which includes while a picker is open over it. Registering both would put
  /// two commands on one press, and the composer would win a press the picker
  /// asked for — Enter would create the workspace instead of choosing a project.
  private var isPlainReturnClaimed: Bool {
    overlayKeys.contains("Enter") || shortcuts.contains { $0.input == "\r" && $0.modifiers.isEmpty }
  }

  private func makeConfiguredShortcutCommand(_ shortcut: HardwareShortcut) -> UIKeyCommand {
    let command = UIKeyCommand(
      input: shortcut.input,
      modifierFlags: shortcut.modifiers,
      action: #selector(handleConfiguredShortcut(_:))
    )
    if #available(iOS 15.0, *) { command.wantsPriorityOverSystemBehavior = true }
    return command
  }

  private func makeSubmitCommand() -> UIKeyCommand {
    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return command
  }

  private func makeShortcutCommand(_ key: String) -> UIKeyCommand? {
    guard let input = namedKeyInputs[key] else { return nil }
    let command = UIKeyCommand(input: input, modifierFlags: [], action: #selector(handleHardwareKeyboardShortcut(_:)))
    if #available(iOS 15.0, *) { command.wantsPriorityOverSystemBehavior = true }
    return command
  }

  @objc
  private func handleConfiguredShortcut(_ sender: UIKeyCommand) {
    guard !isComposingText() else { return }
    guard let shortcut = shortcuts.first(where: {
      $0.input == sender.input && $0.modifiers == sender.modifierFlags
    }) else { return }
    activeModule?.emitShortcut(shortcut)
  }

  @objc
  private func handleHardwareKeyboardSubmit(_ sender: UIKeyCommand) {
    guard canSubmitCurrentTextInput() else {
      return
    }
    activeModule?.emitHardwareKeyboardSubmit()
  }

  @objc
  private func handleHardwareKeyboardShortcut(_ sender: UIKeyCommand) {}

  private func canSubmitCurrentTextInput() -> Bool {
    guard let responder = UIResponder.paseoCurrentFirstResponder else {
      return false
    }
    guard let textInput = responder as? UITextInput else {
      return false
    }
    return textInput.markedTextRange == nil
  }
}

private extension UIResponder {
  private static weak var currentFirstResponder: UIResponder?

  static var paseoCurrentFirstResponder: UIResponder? {
    currentFirstResponder = nil
    UIApplication.shared.sendAction(
      #selector(captureCurrentFirstResponder(_:)),
      to: nil,
      from: nil,
      for: nil
    )
    return currentFirstResponder
  }

  @objc
  private func captureCurrentFirstResponder(_ sender: Any?) {
    UIResponder.currentFirstResponder = self
  }
}


private func hardwareKeyCode(_ key: UIKey) -> String {
  let raw = key.keyCode.rawValue
  if raw >= 4 && raw <= 29 {
    let letter = UnicodeScalar(Int(raw) + 61)!
    return "Key" + String(letter)
  }
  if raw >= 30 && raw <= 38 { return "Digit" + String(raw - 29) }
  if raw == 39 { return "Digit0" }
  let codes: [Int: String] = [
    40: "Enter", 41: "Escape", 42: "Backspace", 43: "Tab", 44: "Space",
    45: "Minus", 46: "Equal", 47: "BracketLeft", 48: "BracketRight",
    49: "Backslash", 51: "Semicolon", 52: "Quote", 53: "Backquote",
    54: "Comma", 55: "Period", 56: "Slash", 76: "Delete", 79: "ArrowRight",
    80: "ArrowLeft", 81: "ArrowDown", 82: "ArrowUp", 224: "ControlLeft",
    225: "ShiftLeft", 226: "AltLeft", 227: "MetaLeft", 228: "ControlRight",
    229: "ShiftRight", 230: "AltRight", 231: "MetaRight",
  ]
  if raw >= 58 && raw <= 69 { return "F" + String(raw - 57) }
  return codes[Int(raw)] ?? ""
}
