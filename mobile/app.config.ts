import type { ExpoConfig } from "expo/config";

// Per-fork identity. Forkers edit these constants once when forking,
// the same way they'd swap a bundle id. Matches the convention in
// other OSS Expo apps (Bluesky, Hydra, Infinite Red, etc.).

const IOS_BUNDLE_ID = "ai.lilaclabs.gini.mobile";
const ANDROID_PACKAGE = "ai.lilaclabs.gini.mobile";
const NSE_BUNDLE_ID = `${IOS_BUNDLE_ID}.notificationservice`;
const APP_NAME = "Gini";
const APP_SLUG = "gini-mobile";
const APP_SCHEME = "gini";
const EAS_PROJECT_ID = "d3a0b9e3-a377-4827-bf3c-274b519f305a";
const EXPO_OWNER = "lilac-labs";
const APPLE_TEAM_ID = "WB6Y3K67AB";

// EAS-hosted OTA URL is deterministic from the project id.
const EXPO_UPDATES_URL = `https://u.expo.dev/${EAS_PROJECT_ID}`;

const config: ExpoConfig = {
  name: APP_NAME,
  slug: APP_SLUG,
  version: "0.0.2",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: APP_SCHEME,
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },
  updates: { url: EXPO_UPDATES_URL, fallbackToCacheTimeout: 0 },
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_ID,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    adaptiveIcon: {
      foregroundImage: "./assets/icon.png",
      backgroundColor: "#ffffff",
    },
  },
  web: { bundler: "metro" },
  plugins: [
    "expo-router",
    [
      "expo-notifications",
      { enableBackgroundRemoteNotifications: true },
    ],
    [
      "./plugins/with-approval-notification-service.js",
      { appleTeamId: APPLE_TEAM_ID },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "Gini uses your photo library to attach images to chat messages.",
        cameraPermission:
          "Gini uses the camera to capture images to attach to chat messages.",
      },
    ],
    "expo-updates",
  ],
  experiments: { typedRoutes: true },
  extra: {
    router: {},
    eas: {
      projectId: EAS_PROJECT_ID,
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: "ApprovalNotificationService",
                bundleIdentifier: NSE_BUNDLE_ID,
              },
            ],
          },
        },
      },
    },
  },
  owner: EXPO_OWNER,
};

export default config;
