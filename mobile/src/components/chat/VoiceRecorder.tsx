import { Feather } from "@expo/vector-icons";
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions
} from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from "react-native-reanimated";
import { uploadAudio } from "@/src/api";
import { family, theme } from "@/src/theme";

// Target a 16 kHz mono 16-bit LinearPCM WAV so the gateway can decode it
// with its pure-JS WAV parser and feed the samples straight to whisper
// without ffmpeg. iOS is the supported recording surface; Android's
// MediaRecorder has no native PCM/WAV path, so the android leg falls
// back to its defaults (recording there is best-effort, not blocking).
const RECORD_OPTIONS: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  isMeteringEnabled: true,
  android: {
    extension: ".wav",
    outputFormat: "default",
    audioEncoder: "default",
    sampleRate: 16000
  },
  ios: {
    extension: ".wav",
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    sampleRate: 16000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false
  },
  web: {
    mimeType: "audio/wav",
    bitsPerSecond: 256000
  }
};

// Horizontal drag (px) past which a release discards instead of sends.
const CANCEL_THRESHOLD = 90;
// A hold that captures less than this is treated as an accidental tap and
// discarded — the gesture activates after a long-press, but a quick
// tap-and-lift can still slip a sub-second clip through.
const MIN_DURATION_MS = 400;

export interface VoiceRef {
  id: string;
  mimeType: string;
  size: number;
  durationMs: number;
}

// Press-and-hold mic with slide-left-to-cancel, Telegram-style. While the
// finger is down past the long-press delay we record; releasing uploads
// the WAV and hands the ref back to the composer, unless the finger slid
// left into the cancel zone (or the clip was too short), in which case the
// recording is discarded silently.
export function VoiceRecorder({
  disabled,
  onSend
}: {
  disabled: boolean;
  onSend: (ref: VoiceRef) => void;
}) {
  const recorder = useAudioRecorder(RECORD_OPTIONS);
  const recorderState = useAudioRecorderState(recorder);
  const [recording, setRecording] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [uploading, setUploading] = useState(false);
  const startedAtRef = useRef<number>(0);
  // Synchronous mirror of "a take is in progress". The gesture's end /
  // finalize callbacks both route here via runOnJS, and a permission
  // denial leaves the take unstarted — gating on this ref keeps us from
  // calling recorder.stop() when nothing is recording.
  const activeRef = useRef(false);

  // Drives the slide-to-cancel hint translation and the pulsing dot. Both
  // live on the UI thread so the drag and pulse stay smooth regardless of
  // JS-thread load while uploading.
  const dragX = useSharedValue(0);
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (recording) {
      pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
  }, [recording, pulse]);

  // Reset the audio session and visual state once a take finishes (sent or
  // discarded). Kept in one place so every exit path converges here.
  const finish = useCallback(async () => {
    setRecording(false);
    setCancelling(false);
    dragX.value = 0;
    await setAudioModeAsync({ allowsRecording: false });
  }, [dragX]);

  const start = useCallback(async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Microphone access required",
        "Enable microphone access in Settings to record voice messages."
      );
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAtRef.current = Date.now();
    activeRef.current = true;
    setCancelling(false);
    setRecording(true);
  }, [recorder]);

  const stop = useCallback(
    async (cancel: boolean) => {
      // A lifted-too-fast tap (gesture never activated) or a denied
      // permission prompt reaches here with no take running — nothing to
      // stop, and recorder.stop() would reject.
      if (!activeRef.current) return;
      activeRef.current = false;
      const durationMs = Date.now() - startedAtRef.current;
      await recorder.stop();
      const uri = recorder.uri;
      await finish();
      // Discard on cancel-zone release, a too-short hold (a tap, not a
      // hold), or a missing uri (recorder never produced a file).
      if (cancel || !uri || durationMs < MIN_DURATION_MS) return;
      setUploading(true);
      try {
        const ref = await uploadAudio({ uri, name: "voice.wav", mimeType: "audio/wav" });
        onSend({ ...ref, durationMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert("Voice message failed", message);
      } finally {
        setUploading(false);
      }
    },
    [recorder, finish, onSend]
  );

  // Pan with a long-press activation: a quick tap never starts a take, but
  // once held the same gesture tracks the horizontal drag for cancel. JS
  // work (recorder + upload) is bounced off the UI thread via runOnJS.
  const gesture = Gesture.Pan()
    .activateAfterLongPress(180)
    .enabled(!disabled && !uploading)
    .onStart(() => {
      dragX.value = 0;
      runOnJS(start)();
    })
    .onUpdate((event) => {
      // Clamp to a leftward-only travel so the hint can't drift right.
      dragX.value = Math.min(0, event.translationX);
      runOnJS(setCancelling)(event.translationX < -CANCEL_THRESHOLD);
    })
    .onEnd((event) => {
      runOnJS(stop)(event.translationX < -CANCEL_THRESHOLD);
    })
    .onFinalize((_event, success) => {
      // A failed activation (lifted before the long-press fired) never hit
      // onStart, so there's nothing to stop — guard on success.
      if (!success) runOnJS(stop)(true);
    });

  const dotStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + pulse.value * 0.6
  }));
  const hintStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragX.value }]
  }));

  const elapsed = formatDuration(recorderState.durationMillis);

  return (
    <>
      <GestureDetector gesture={gesture}>
        <View
          style={[styles.micButton, (disabled || uploading) && styles.micButtonDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Hold to record a voice message"
        >
          <Feather name="mic" size={22} color={theme.buttonText} />
        </View>
      </GestureDetector>

      {recording ? (
        <View style={styles.overlay} pointerEvents="none">
          <Animated.View style={[styles.dot, dotStyle]} />
          <Text style={styles.timer}>{elapsed}</Text>
          <Animated.View style={[styles.hint, hintStyle]}>
            {cancelling ? (
              <Feather name="trash-2" size={16} color={theme.danger} />
            ) : (
              <Feather name="chevron-left" size={16} color={theme.muted} />
            )}
            <Text style={[styles.hintText, cancelling && styles.hintTextCancel]}>
              {cancelling ? "Release to cancel" : "Slide to cancel"}
            </Text>
          </Animated.View>
        </View>
      ) : null}
    </>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.button,
    alignItems: "center",
    justifyContent: "center"
  },
  micButtonDisabled: { backgroundColor: theme.buttonDisabled },

  // Recording bar — sits over the input pill so the timer + cancel hint
  // replace the composer chrome while a take is in progress. The mic
  // button itself stays visible underneath at the right edge.
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 56,
    borderRadius: 28,
    backgroundColor: theme.bg,
    gap: 10
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.danger
  },
  timer: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    minWidth: 44
  },
  hint: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4
  },
  hintText: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 15
  },
  hintTextCancel: { color: theme.danger }
});
