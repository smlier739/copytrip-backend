// mobile/authContext.js
import React, { createContext, useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import Constants from "expo-constants";

export const AuthContext = createContext(null);

const ENTITLEMENT_ID = "pro";

// Expo Go: appOwnership === "expo"
function isExpoGo() {
  return Constants?.appOwnership === "expo";
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [isPro, setIsPro] = useState(false);
  const [booting, setBooting] = useState(true);

  // UI-flag (Paywall bruker denne)
  const [purchasesReady, setPurchasesReady] = useState(Platform.OS !== "ios");

  // kun config én gang
  const rcConfiguredRef = useRef(false);

  // lazy refs til Purchases + LOG_LEVEL (for å unngå crash/import-problemer)
  const purchasesRef = useRef(null);
  const logLevelRef = useRef(null);

  const isLoggedIn = !!token;

  /**
   * Lazy-load Purchases.
   * - Returnerer null i Expo Go
   * - Returnerer null hvis native module mangler / import feiler
   */
  const getPurchases = useCallback(() => {
    if (Platform.OS !== "ios") return null;
    if (isExpoGo()) return null;

    if (purchasesRef.current) return purchasesRef.current;

    try {
      const mod = require("react-native-purchases");
      const Purchases = mod.default ?? mod;
      purchasesRef.current = Purchases;
      logLevelRef.current = mod.LOG_LEVEL ?? null;
      return Purchases;
    } catch (e) {
      console.warn("❌ Klarte ikke å laste react-native-purchases:", e);
      return null;
    }
  }, []);

  /**
   * Sørger for at RevenueCat er konfigurert.
   * Returnerer true/false og oppdaterer purchasesReady.
   */
  const ensurePurchasesConfigured = useCallback(async () => {
    if (Platform.OS !== "ios") return true;

    const apiKey = process.env.EXPO_PUBLIC_RC_IOS_KEY;

    if (!apiKey) {
      console.warn("❌ Mangler EXPO_PUBLIC_RC_IOS_KEY (RevenueCat public iOS SDK key).");
      setPurchasesReady(false);
      return false;
    }

    const Purchases = getPurchases();
    if (!Purchases) {
      console.warn(
        "❌ Purchases ikke tilgjengelig i denne runtime. " +
          "Hvis dette er TestFlight/standalone: builden mangler native module."
      );
      setPurchasesReady(false);
      return false;
    }

    if (rcConfiguredRef.current) {
      setPurchasesReady(true);
      return true;
    }

    try {
      // Sett log level (valgfritt)
      const LOG_LEVEL = logLevelRef.current;
      if (LOG_LEVEL?.DEBUG) {
        Purchases.setLogLevel(LOG_LEVEL.DEBUG);
      }

      // Configure én gang
      Purchases.configure({ apiKey });

      rcConfiguredRef.current = true;
      setPurchasesReady(true);
      return true;
    } catch (e) {
      console.warn("❌ Purchases.configure feilet:", e);
      setPurchasesReady(false);
      return false;
    }
  }, [getPurchases]);

  /**
   * Henter pro-status fra RevenueCat (iOS) eller cache (andre plattformer)
   */
  const refreshProStatus = useCallback(async () => {
    try {
      if (Platform.OS !== "ios") {
        const v = await AsyncStorage.getItem("isPro");
        const active = v === "1";
        setIsPro(active);
        return active;
      }

      const ok = await ensurePurchasesConfigured();
      if (!ok) return false;

      const Purchases = getPurchases();
      if (!Purchases) return false;

      const info = await Purchases.getCustomerInfo();
      const active = !!info?.entitlements?.active?.[ENTITLEMENT_ID];

      setIsPro(active);

      // lokal cache (valgfritt, men praktisk for UI)
      if (active) await AsyncStorage.setItem("isPro", "1");
      else await AsyncStorage.removeItem("isPro");

      return active;
    } catch (e) {
      console.warn("refreshProStatus-feil:", e);
      return false;
    }
  }, [ensurePurchasesConfigured, getPurchases]);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const t = await AsyncStorage.getItem("authToken");
        if (!alive) return;
        if (t) setToken(t);

        // init purchases + sync pro
        await ensurePurchasesConfigured();
        await refreshProStatus();
      } catch (e) {
        console.warn("AuthProvider boot-feil:", e);
      } finally {
        if (!alive) return;
        setBooting(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [ensurePurchasesConfigured, refreshProStatus]);

  const login = useCallback(async (newToken, user = null) => {
    if (newToken) await AsyncStorage.setItem("authToken", newToken);
    if (user) await AsyncStorage.setItem("currentUser", JSON.stringify(user));
    setToken(newToken || null);
    await refreshProStatus();
  }, [refreshProStatus]);

  const logout = useCallback(async () => {
    await AsyncStorage.removeItem("authToken");
    await AsyncStorage.removeItem("currentUser");
    setToken(null);

    await AsyncStorage.removeItem("isPro");
    setIsPro(false);
  }, []);

  const disablePro = useCallback(async () => {
    await AsyncStorage.removeItem("isPro");
    setIsPro(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        setToken,
        isLoggedIn,
        login,
        logout,

        isPro,
        refreshProStatus,
        disablePro,

        booting,

        // RevenueCat helpers for PaywallScreen
        ensurePurchasesConfigured,
        purchasesReady,

        // ✅ PaywallScreen skal bruke denne for å hente Purchases trygt
        getPurchases,

        // (valgfritt) debug
        _rcDebug: {
          ios: Platform.OS === "ios",
          expoGo: isExpoGo(),
          hasKey: !!process.env.EXPO_PUBLIC_RC_IOS_KEY
        }
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
