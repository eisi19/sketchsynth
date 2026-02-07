# SketchSynth

**SketchSynth** is a web-based interactive synthesizer that explores the relationship between visual shapes and audio timbre. It allows users to hand-draw custom waveforms, shape them with synthesis tools, and perform using virtual or external MIDI inputs.

![Project Screenshot](/GUI - screenshot.png)

## Features

SketchSynth is structured into four main modules, providing a complete signal path from oscillator generation to audio output.

### 1. Waveform Setup
The core generation engine where timbre is defined.
- **Draw Waveforms:** Use the interactive canvas to hand-draw custom single-cycle waveforms.
- **Presets:** Quick access to standard analog shapes: Sine, Sawtooth, Square, and Triangle.
- **I/O Management:**
  - **Export:** Save waveform data for future use.
  - **Load:** Import waveform data via CSV files.
  - **Clear:** Reset the canvas instantly.

### 2. Envelope Designer (ADSR)
Controls the amplitude dynamics of the sound.
- **Parameters:** Adjust Attack, Decay, Sustain, and Release times.
- **Routing:** Toggle the envelope generator ON/OFF within the audio chain.

### 3. Filter Designer
A dual-stage filter section for spectral shaping.
- **Low Pass Filter:** Variable Cutoff, Resonance, and Slope.
- **High Pass Filter:** Variable Cutoff, Resonance, and Slope.
- **Independent Control:** Activate or disable filters individually.

### 4. Performance & Output
The interface for musical performance.
- **Virtual Keyboard:** On-screen two-octaves piano interface.
- **Octave Control:** Switchable range spanning 6 octaves (1st to 6th piano octave).
- **MIDI Integration:** Support for external MIDI keyboards.
- **Output:** Master volume slider for final gain staging.

## Development & coding tools

- **Core:** HTML5, CSS3, JavaScript
- **Audio:** Web Audio API

## How to use
1. Draw your waveform in the canvas or select a preset.
2. Adjust the ADSR times for the amplitude envelope (optional)
3. Adjust the filters to achieve the desired timbre
4. Play on the keyboard and select the desider octave or connect an external MIDI keyboard (not supported on every browser)
