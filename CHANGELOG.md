# Changelog

All notable changes to MMM-Rehearsal will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Full-screen MagicMirror rehearsal display and local browser controller
- Local script library, cues, target timing, and rehearsal scoring
- Microphone-based script tracking and automatic teleprompter mode
- QR controller access with configurable and LAN-aware URL detection
- Bulgarian, Danish, German, English, Spanish, French, Hungarian, Dutch, Russian, and Thai translations
- Semantic MagicMirror notifications for external controls and state updates
- Controller session recovery after a reload or reopened page
- Remembered presentation mode, auto-end, speaking-pace, and text-size preferences
- Focus, Auto, and smooth-scrolling Classic presentation modes
- Optional voice analysis and speech-based scoring in Auto and Classic modes
- Estimated script accuracy with up to three suggested lines to review in Rehearsal Studio
- Configurable MagicMirror visibility locking while a rehearsal is ready or active
- Locally bundled Bootstrap 5.3 controller components and a persistent user theme override

### Changed

- Simplified the README introduction and clarified browser speech-recognition privacy
- Softened focused-section transitions for less distracting movement
- Timing-only summaries now leave speech-derived metrics ungraded
- Classic scrolling now uses a stable timing anchor to remove word-update jitter
- Stop commands now use a dedicated endpoint and freeze the mirror before detailed analysis
- Rehearsal Studio completion messages now reflect estimated accuracy without punitive language

## [0.1.0] - 2026-08-26

- Initial private repository release.
