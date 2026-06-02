import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { family, theme } from "@/src/theme";

// Bottom-docked action sheet built on <Modal> + the legacy Animated API,
// mirroring the agent-drawer pattern in app/agents.tsx. iOS native callers
// should prefer ActionSheetIOS; this is the cross-surface fallback (RN Web,
// Android) so the menu slides up from the bottom instead of rendering as a
// centered Alert card.

// react-native-web warns when useNativeDriver is true (no native animated
// module on web), so opt out there while keeping the native driver on device.
const USE_NATIVE_DRIVER = Platform.OS !== "web";
const ANIM_DURATION = 220;
// Initial off-screen translate before the sheet has measured its own height;
// the entrance/exit use the cached measured height once it's known.
const FALLBACK_OFFSCREEN = 800;

export interface ActionSheetOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export function ActionSheet({
  visible,
  title,
  options,
  cancelLabel = "Cancel",
  onClose
}: {
  visible: boolean;
  title?: string;
  options: ActionSheetOption[];
  cancelLabel?: string;
  onClose: () => void;
}) {
  // Read insets from context rather than wrapping in <SafeAreaView>: the
  // sheet renders inside a <Modal> (separate native hierarchy on iOS), so
  // context-provided insets are the reliable measured values here.
  const insets = useSafeAreaInsets();
  // `mounted` decouples render lifetime from `visible` so the exit
  // animation runs to completion before the Modal unmounts.
  const [mounted, setMounted] = useState(visible);
  const translateY = useRef(new Animated.Value(FALLBACK_OFFSCREEN)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // Cache the measured sheet height so entrance/exit always travel exactly
  // the sheet's own height. `onLayout` fills this on first render.
  const sheetHeight = useRef(FALLBACK_OFFSCREEN);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.setValue(sheetHeight.current);
      const anim = Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: ANIM_DURATION,
          useNativeDriver: USE_NATIVE_DRIVER
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: ANIM_DURATION,
          useNativeDriver: USE_NATIVE_DRIVER
        })
      ]);
      anim.start();
      return () => {
        anim.stop();
      };
    }
    const anim = Animated.parallel([
      Animated.timing(translateY, {
        toValue: sheetHeight.current,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      })
    ]);
    anim.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => {
      anim.stop();
    };
  }, [visible, translateY, opacity]);

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss menu"
        >
          <Animated.View style={[styles.backdrop, { opacity }]} />
        </Pressable>
        <Animated.View
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            if (height > 0) sheetHeight.current = height;
          }}
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + 8,
              transform: [{ translateY }]
            }
          ]}
        >
          <View style={styles.optionGroup}>
            {title ? (
              <View style={styles.titleRow}>
                <Text style={styles.titleText}>{title}</Text>
              </View>
            ) : null}
            {options.map((option, index) => (
              <Pressable
                key={option.label}
                onPress={() => {
                  onClose();
                  option.onPress();
                }}
                style={({ pressed }) => [
                  styles.optionRow,
                  index > 0 && styles.optionDivider,
                  pressed && styles.pressed
                ]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.optionLabel,
                    option.destructive && styles.destructiveLabel
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.cancelGroup, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
          >
            <Text style={styles.cancelLabel}>{cancelLabel}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { paddingHorizontal: 8 },
  optionGroup: {
    backgroundColor: theme.bg,
    borderRadius: 14,
    overflow: "hidden"
  },
  titleRow: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border
  },
  titleText: { color: theme.muted, fontSize: 13 },
  optionRow: { height: 57, alignItems: "center", justifyContent: "center" },
  optionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border
  },
  optionLabel: {
    fontSize: 20,
    fontFamily: family("HankenGrotesk", 500),
    color: theme.accent
  },
  destructiveLabel: { color: theme.danger },
  cancelGroup: {
    marginTop: 8,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.bg,
    borderRadius: 14
  },
  cancelLabel: {
    fontSize: 20,
    fontFamily: family("HankenGrotesk", 600),
    color: theme.accent
  },
  pressed: { backgroundColor: "rgba(0,0,0,0.06)" }
});
