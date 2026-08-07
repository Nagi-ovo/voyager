//
//  ViewController.swift
//  Voyager
//
//  Created by Jesse Zhang on 15/05/2026.
//

import Cocoa
import SafariServices
import os.log

let extensionBundleIdentifier = "com.yourCompany.Gemini-Voyager.Extension"

class ViewController: NSViewController {

  private enum Metrics {
    static let windowPadding: CGFloat = 20
    static let rowInset: CGFloat = 14
    static let rowSpacing: CGFloat = 11
    static let sectionSpacing: CGFloat = 22
  }

  private let diagnosticsService = NativeDiagnosticsService()
  private var updaterAvailabilityObservation: NSKeyValueObservation?
  private var hasLoadedInitialState = false

  private let stateLabel = ViewController.makeLabel(
    font: .systemFont(ofSize: 13),
    color: .secondaryLabelColor
  )
  private let openPreferencesButton = NSButton()
  private let automaticUpdatesSwitch = NSSwitch()
  private let checkForUpdatesButton = NSButton()
  private let diagnosticsCard = CardView()

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    buildInterface()
    showDiagnosticsPlaceholder()
  }

  override func viewWillAppear() {
    super.viewWillAppear()
    guard !hasLoadedInitialState, let appDelegate = NSApp.delegate as? AppDelegate else { return }
    hasLoadedInitialState = true
    observeUpdaterAvailability(appDelegate)
    updateUpdaterControls(appDelegate)
    updateExtensionState()
    updateDiagnostics(appDelegate)
  }

  // MARK: - Interface

  private func buildInterface() {
    let sections = [makeHeroSection(), makeUpdatesSection(), makeDiagnosticsSection()]
    let content = NSStackView(views: sections)
    content.orientation = .vertical
    content.alignment = .leading
    content.spacing = Metrics.sectionSpacing
    content.edgeInsets = NSEdgeInsets(
      top: Metrics.windowPadding,
      left: Metrics.windowPadding,
      bottom: Metrics.windowPadding,
      right: Metrics.windowPadding
    )
    content.translatesAutoresizingMaskIntoConstraints = false

    // Flipped so the stack lays out from the top edge down, the way a scrolled
    // settings pane should; an unflipped document view would pin it to the bottom.
    let documentView = FlippedView()
    documentView.translatesAutoresizingMaskIntoConstraints = false
    documentView.addSubview(content)

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.autohidesScrollers = true
    scrollView.documentView = documentView
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scrollView)

    NSLayoutConstraint.activate([
      scrollView.topAnchor.constraint(equalTo: view.topAnchor),
      scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

      documentView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
      content.topAnchor.constraint(equalTo: documentView.topAnchor),
      content.bottomAnchor.constraint(equalTo: documentView.bottomAnchor),
      content.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
      content.trailingAnchor.constraint(equalTo: documentView.trailingAnchor),
    ])

    // `.width` alignment would only make the sections equal to each other, so pin
    // each one to the stack's content width explicitly.
    for section in sections {
      section.widthAnchor.constraint(
        equalTo: content.widthAnchor,
        constant: -2 * Metrics.windowPadding
      ).isActive = true
    }
  }

  private func makeHeroSection() -> NSView {
    let iconView = NSImageView()
    iconView.image = NSApp.applicationIconImage
    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      iconView.widthAnchor.constraint(equalToConstant: 64),
      iconView.heightAnchor.constraint(equalToConstant: 64),
    ])

    let titleLabel = Self.makeLabel(font: .systemFont(ofSize: 20, weight: .semibold))
    titleLabel.stringValue = "Voyager"

    stateLabel.stringValue = Self.stateCopy(for: nil)
    stateLabel.alignment = .center
    stateLabel.maximumNumberOfLines = 3
    stateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    openPreferencesButton.title = Self.openPreferencesTitle
    openPreferencesButton.bezelStyle = .rounded
    openPreferencesButton.controlSize = .large
    openPreferencesButton.keyEquivalent = "\r"
    openPreferencesButton.target = self
    openPreferencesButton.action = #selector(openPreferences)

    let stack = NSStackView(views: [iconView, titleLabel, stateLabel, openPreferencesButton])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 8
    stack.setCustomSpacing(4, after: titleLabel)
    stack.setCustomSpacing(14, after: stateLabel)
    return stack
  }

  private func makeUpdatesSection() -> NSView {
    automaticUpdatesSwitch.target = self
    automaticUpdatesSwitch.action = #selector(toggleAutomaticUpdates)

    let updatesRow = SettingRow(
      title: "Automatic updates",
      detail: "Keep Voyager up to date in the background.",
      accessory: automaticUpdatesSwitch
    )

    checkForUpdatesButton.title = "Check for updates"
    checkForUpdatesButton.bezelStyle = .rounded
    checkForUpdatesButton.target = self
    checkForUpdatesButton.action = #selector(checkForUpdates)

    let buttonRow = Self.makeButtonRow(checkForUpdatesButton)
    let card = CardView()
    card.setRows([updatesRow, buttonRow])
    return Self.makeSection(title: "Updates", subtitle: nil, accessory: nil, body: card)
  }

  private func makeDiagnosticsSection() -> NSView {
    let refreshButton = NSButton()
    refreshButton.title = "Refresh"
    refreshButton.bezelStyle = .rounded
    refreshButton.controlSize = .small
    refreshButton.target = self
    refreshButton.action = #selector(refreshDiagnostics)
    refreshButton.setAccessibilityLabel("Refresh system status")

    return Self.makeSection(
      title: "System status",
      subtitle: "Safari and native integrations",
      accessory: refreshButton,
      body: diagnosticsCard
    )
  }

  // MARK: - Actions

  @objc private func openPreferences() {
    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
      DispatchQueue.main.async {
        NSApplication.shared.terminate(nil)
      }
    }
  }

  @objc private func toggleAutomaticUpdates() {
    guard let appDelegate = NSApp.delegate as? AppDelegate else { return }
    appDelegate.setAutomaticUpdatesEnabled(automaticUpdatesSwitch.state == .on)
    updateUpdaterControls(appDelegate)
  }

  @objc private func checkForUpdates() {
    guard let appDelegate = NSApp.delegate as? AppDelegate else { return }
    appDelegate.checkForUpdates(nil)
    updateUpdaterControls(appDelegate)
  }

  @objc private func refreshDiagnostics() {
    guard let appDelegate = NSApp.delegate as? AppDelegate else { return }
    showDiagnosticsPlaceholder()
    updateExtensionState()
    updateDiagnostics(appDelegate)
  }

  // MARK: - State

  private func updateExtensionState() {
    SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) {
      (state, error) in
      let isEnabled = error == nil ? state?.isEnabled : nil

      DispatchQueue.main.async {
        self.stateLabel.stringValue = Self.stateCopy(for: isEnabled)
      }
    }
  }

  private func updateUpdaterControls(_ appDelegate: AppDelegate) {
    automaticUpdatesSwitch.state = appDelegate.automaticUpdatesEnabled ? .on : .off
    checkForUpdatesButton.isEnabled = appDelegate.canCheckForUpdates
  }

  private func observeUpdaterAvailability(_ appDelegate: AppDelegate) {
    guard updaterAvailabilityObservation == nil else { return }
    updaterAvailabilityObservation = appDelegate.observeCanCheckForUpdates {
      [weak self, weak appDelegate] in
      guard let self, let appDelegate else { return }
      self.updateUpdaterControls(appDelegate)
    }
  }

  private func updateDiagnostics(_ appDelegate: AppDelegate) {
    diagnosticsService.collect(appDelegate: appDelegate) { [weak self] snapshot in
      DispatchQueue.main.async {
        self?.showDiagnostics(snapshot)
      }
    }
  }

  private func showDiagnosticsPlaceholder() {
    let label = Self.makeLabel(font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
    label.stringValue = "Checking…"
    diagnosticsCard.setRows([Self.makePlaceholderRow(label)])
  }

  private func showDiagnostics(_ snapshot: VoyagerDiagnosticsSnapshot) {
    diagnosticsCard.setRows(
      snapshot.items.map {
        SettingRow(title: $0.label, detail: $0.detail, accessory: StatusView($0))
      }
    )
  }

  // MARK: - Copy

  private static var usesSettingsWording: Bool {
    if #available(macOS 13, *) { return true }
    return false
  }

  private static var openPreferencesTitle: String {
    usesSettingsWording ? "Open Safari Extensions…" : "Open Safari Extensions Preferences…"
  }

  private static func stateCopy(for isEnabled: Bool?) -> String {
    let location = usesSettingsWording ? "Safari Extensions" : "Safari Extensions preferences"
    switch isEnabled {
    case .some(true):
      return "The Safari extension is on and ready."
    case .some(false):
      return "The Safari extension is off. Turn it on in \(location)."
    case .none:
      return "Turn on Voyager in \(location) to get started."
    }
  }

  // MARK: - View factories

  fileprivate static func makeLabel(font: NSFont, color: NSColor = .labelColor) -> NSTextField {
    let label = NSTextField(labelWithString: "")
    label.font = font
    label.textColor = color
    label.lineBreakMode = .byWordWrapping
    return label
  }

  private static func makeSection(
    title: String,
    subtitle: String?,
    accessory: NSView?,
    body: NSView
  ) -> NSView {
    let titleLabel = makeLabel(font: .systemFont(ofSize: 13, weight: .semibold))
    titleLabel.stringValue = title

    let headingCopy = NSStackView(views: [titleLabel])
    headingCopy.orientation = .vertical
    headingCopy.alignment = .leading
    headingCopy.spacing = 1

    if let subtitle {
      let subtitleLabel = makeLabel(font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
      subtitleLabel.stringValue = subtitle
      headingCopy.addArrangedSubview(subtitleLabel)
    }

    let heading = NSStackView(views: [headingCopy])
    heading.orientation = .horizontal
    heading.alignment = .centerY
    heading.edgeInsets = NSEdgeInsets(top: 0, left: 2, bottom: 0, right: 0)

    if let accessory {
      let spacer = NSView()
      spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
      heading.addArrangedSubview(spacer)
      accessory.setContentHuggingPriority(.required, for: .horizontal)
      heading.addArrangedSubview(accessory)
    }

    let section = NSStackView(views: [heading, body])
    section.orientation = .vertical
    section.alignment = .leading
    section.spacing = 7
    NSLayoutConstraint.activate([
      heading.widthAnchor.constraint(equalTo: section.widthAnchor),
      body.widthAnchor.constraint(equalTo: section.widthAnchor),
    ])
    return section
  }

  /// Wraps a bare control in a row so it picks up the card's standard insets.
  private static func makeButtonRow(_ button: NSButton) -> NSView {
    let container = NSView()
    button.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(button)
    NSLayoutConstraint.activate([
      button.topAnchor.constraint(equalTo: container.topAnchor, constant: Metrics.rowSpacing),
      button.bottomAnchor.constraint(
        equalTo: container.bottomAnchor, constant: -Metrics.rowSpacing),
      button.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Metrics.rowInset),
      button.trailingAnchor.constraint(
        lessThanOrEqualTo: container.trailingAnchor, constant: -Metrics.rowInset),
    ])
    return container
  }

  private static func makePlaceholderRow(_ label: NSTextField) -> NSView {
    let container = NSView()
    label.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(label)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: container.topAnchor, constant: Metrics.rowSpacing),
      label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -Metrics.rowSpacing),
      label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Metrics.rowInset),
      label.trailingAnchor.constraint(
        lessThanOrEqualTo: container.trailingAnchor, constant: -Metrics.rowInset),
    ])
    return container
  }
}

// MARK: - Layout helpers

/// Top-down coordinate space, required for content inside an `NSScrollView`.
private final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// Multi-line label that reports the right height for whatever width it is given.
private final class WrappingLabel: NSTextField {
  override func layout() {
    if abs(preferredMaxLayoutWidth - bounds.width) > 0.5 {
      preferredMaxLayoutWidth = bounds.width
      invalidateIntrinsicContentSize()
    }
    super.layout()
  }
}

/// Grouped-list container: rounded background plus hairlines inset to the text column.
private final class CardView: NSView {
  private var rowViews: [NSView] = []

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 8
    layer?.borderWidth = 1
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    layer?.borderColor = NSColor.separatorColor.cgColor
  }

  func setRows(_ rows: [NSView]) {
    for view in rowViews { view.removeFromSuperview() }
    rowViews = rows

    var previous: NSView?
    for row in rows {
      row.translatesAutoresizingMaskIntoConstraints = false
      addSubview(row)

      if let previous {
        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)
        NSLayoutConstraint.activate([
          separator.topAnchor.constraint(equalTo: previous.bottomAnchor),
          separator.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
          separator.trailingAnchor.constraint(equalTo: trailingAnchor),
          row.topAnchor.constraint(equalTo: separator.bottomAnchor),
        ])
      } else {
        row.topAnchor.constraint(equalTo: topAnchor).isActive = true
      }

      NSLayoutConstraint.activate([
        row.leadingAnchor.constraint(equalTo: leadingAnchor),
        row.trailingAnchor.constraint(equalTo: trailingAnchor),
      ])
      previous = row
    }

    previous?.bottomAnchor.constraint(equalTo: bottomAnchor).isActive = true
  }
}

/// One line of a grouped list: title over an optional detail, control pinned right.
private final class SettingRow: NSView {
  init(title: String, detail: String, accessory: NSView) {
    super.init(frame: .zero)

    let titleLabel = ViewController.makeLabel(font: .systemFont(ofSize: 13, weight: .medium))
    titleLabel.stringValue = title
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    let detailLabel = WrappingLabel(labelWithString: detail)
    detailLabel.font = .systemFont(ofSize: 11)
    detailLabel.textColor = .secondaryLabelColor
    detailLabel.lineBreakMode = .byWordWrapping
    detailLabel.maximumNumberOfLines = 0
    detailLabel.translatesAutoresizingMaskIntoConstraints = false

    // Let the copy wrap instead of forcing the card wider than the window.
    for label in [titleLabel, detailLabel] {
      label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      label.setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    accessory.translatesAutoresizingMaskIntoConstraints = false
    accessory.setContentHuggingPriority(.required, for: .horizontal)
    accessory.setContentCompressionResistancePriority(.required, for: .horizontal)

    addSubview(titleLabel)
    addSubview(detailLabel)
    addSubview(accessory)

    let inset: CGFloat = 14
    let vertical: CGFloat = 11

    NSLayoutConstraint.activate([
      titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: vertical),
      titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: accessory.leadingAnchor, constant: -12),

      detailLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 1),
      detailLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
      detailLabel.trailingAnchor.constraint(equalTo: accessory.leadingAnchor, constant: -12),
      detailLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -vertical),

      accessory.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset),
      accessory.centerYAnchor.constraint(equalTo: centerYAnchor),
      accessory.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: vertical),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var isFlipped: Bool { true }
}

/// Diagnostic value shown the way macOS does it: a tinted dot next to plain text.
private final class StatusView: NSView {
  private let level: VoyagerDiagnosticLevel
  private let dot = NSView()

  init(_ item: VoyagerDiagnosticItem) {
    self.level = item.level
    super.init(frame: .zero)

    dot.wantsLayer = true
    dot.layer?.cornerRadius = 3
    dot.translatesAutoresizingMaskIntoConstraints = false
    addSubview(dot)

    let label = ViewController.makeLabel(font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
    label.stringValue = item.value
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)

    NSLayoutConstraint.activate([
      dot.widthAnchor.constraint(equalToConstant: 6),
      dot.heightAnchor.constraint(equalToConstant: 6),
      dot.leadingAnchor.constraint(equalTo: leadingAnchor),
      dot.centerYAnchor.constraint(equalTo: centerYAnchor),

      label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 6),
      label.trailingAnchor.constraint(equalTo: trailingAnchor),
      label.topAnchor.constraint(equalTo: topAnchor),
      label.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    dot.layer?.backgroundColor = level.dotColor.cgColor
  }
}

extension VoyagerDiagnosticLevel {
  fileprivate var dotColor: NSColor {
    switch self {
    case .ready: return .systemGreen
    case .attention: return .systemOrange
    case .neutral: return .tertiaryLabelColor
    }
  }
}
