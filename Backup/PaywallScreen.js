import React, { useMemo, useState, useContext, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Platform,
  Linking,
  ScrollView
} from "react-native";
import { AuthContext } from "../authContext";

const FEATURE_COPY = {
  Hotels: { headline: "Lås opp hoteller", body: "Få komplette hotellforslag med klikkbare lenker og anbefalinger." },
  Experiences: { headline: "Lås opp opplevelser", body: "Få forslag til aktiviteter, billetter og booking-lenker." },
  PackingList: { headline: "Lås opp pakkeliste", body: "Få en ferdig pakkeliste tilpasset reisen." },
  manage: { headline: "Grenseløs Reise Pluss", body: "Administrer abonnementet ditt og gjenopprett kjøp." }
};

function labelForPackage(pkg) {
  const t = String(pkg?.packageType || "").toUpperCase();
  if (t.includes("ANNUAL")) return "Årlig";
  if (t.includes("MONTHLY")) return "Månedlig";
  if (t.includes("WEEKLY")) return "Ukentlig";
  if (t.includes("LIFETIME")) return "Livstid";
  return "Abonnement";
}

function suffixForPackage(pkg) {
  const t = String(pkg?.packageType || "").toUpperCase();
  if (t.includes("ANNUAL")) return "/ år";
  if (t.includes("MONTHLY")) return "/ mnd";
  if (t.includes("WEEKLY")) return "/ uke";
  return "";
}

export default function PaywallScreen({ navigation, route }) {
  const {
    isPro,
    refreshProStatus,
    ensurePurchasesConfigured,
    purchasesReady,
    getPurchases, // ✅ fra AuthContext
    disablePro,
    booting,
    _rcDebug
  } = useContext(AuthContext);

  const { feature, tripTitle, returnTo, returnParams } = route.params || {};
  const isManage = feature === "manage";

  const copy = useMemo(() => {
    const fallback = { headline: "Lås opp innhold", body: "Dette innholdet ligger bak betalingsmur." };
    return FEATURE_COPY[feature] || fallback;
  }, [feature]);

  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState([]);
  const [selectedPkg, setSelectedPkg] = useState(null);
  const [errorText, setErrorText] = useState(null);

  const loadOfferings = useCallback(async () => {
    try {
      setErrorText(null);

      if (Platform.OS !== "ios") return;
      if (booting) return;

      const ok = await ensurePurchasesConfigured?.();
      const Purchases = getPurchases?.();

      if (!ok || !Purchases) {
        setPackages([]);
        setSelectedPkg(null);
        setErrorText("Kjøpssystemet er ikke klart. Sjekk RC-key / at builden inneholder Purchases.");
        return;
      }

      const offerings = await Purchases.getOfferings();
      const current = offerings?.current;
      const list = current?.availablePackages || [];

      setPackages(list);

      // Default: velg annual hvis finnes, ellers monthly, ellers første
      const preferred =
        list.find((p) => String(p?.packageType || "").toUpperCase().includes("ANNUAL")) ||
        list.find((p) => String(p?.packageType || "").toUpperCase().includes("MONTHLY")) ||
        list[0] ||
        null;

      setSelectedPkg(preferred);

      if (!preferred) {
        setErrorText("Fant ingen produkter. Sjekk Offering=default og at packages peker på riktige produkter i RevenueCat.");
      }
    } catch (e) {
      console.warn("Offerings-feil:", e);
      setPackages([]);
      setSelectedPkg(null);
      setErrorText("Kunne ikke hente produkter. Sjekk RevenueCat-oppsett og nettverk.");
    }
  }, [booting, ensurePurchasesConfigured, getPurchases]);

  useEffect(() => {
    loadOfferings();
  }, [loadOfferings]);

  async function afterSuccessNavigate() {
    if (returnTo) navigation.replace(returnTo, returnParams || {});
    else navigation.goBack();
  }

  async function onSubscribe() {
    try {
      setLoading(true);

      if (Platform.OS !== "ios") {
        Alert.alert("Ikke støttet", "Kjøp er satt opp for iOS først.");
        return;
      }

      const ok = await ensurePurchasesConfigured?.();
      const Purchases = getPurchases?.();

      if (!ok || !Purchases) {
        Alert.alert("Kjøp ikke klart", "Purchases er ikke tilgjengelig i denne builden.");
        return;
      }

      if (!selectedPkg) {
        Alert.alert("Velg abonnement", "Vi fant ingen pakke å kjøpe. Last produkter på nytt.");
        return;
      }

      await Purchases.purchasePackage(selectedPkg);

      const active = await refreshProStatus?.();
      if (!active) {
        Alert.alert("Kjøp fullført", "Vi fant ikke aktivt abonnement ennå. Prøv å gjenopprette kjøp.");
        return;
      }

      await afterSuccessNavigate();
    } catch (e) {
      const userCancelled = e?.userCancelled || e?.code === "PURCHASE_CANCELLED";
      if (userCancelled) return;

      console.warn("Paywall subscribe-feil:", e);
      Alert.alert("Noe gikk galt", "Kunne ikke fullføre kjøpet. Prøv igjen.");
    } finally {
      setLoading(false);
    }
  }

  async function onRestore() {
    try {
      setLoading(true);

      const ok = await ensurePurchasesConfigured?.();
      const Purchases = getPurchases?.();

      if (!ok || !Purchases) {
        Alert.alert("Ikke klart", "Purchases er ikke tilgjengelig i denne builden.");
        return;
      }

      await Purchases.restorePurchases();
      const active = await refreshProStatus?.();

      if (active) Alert.alert("Gjenopprettet", "Abonnementet ditt er aktivt.");
      else Alert.alert("Ingen kjøp funnet", "Vi fant ingen aktive kjøp å gjenopprette.");
    } catch (e) {
      console.warn("Paywall restore-feil:", e);
      Alert.alert("Feil", "Kunne ikke gjenopprette kjøp. Prøv igjen.");
    } finally {
      setLoading(false);
    }
  }

  function onManageSubscriptions() {
    Linking.openURL("https://apps.apple.com/account/subscriptions").catch(() => {
      Alert.alert("Kunne ikke åpne", "Åpne App Store → konto → Abonnementer.");
    });
  }

  const ctaDisabled =
    loading ||
    isPro ||
    booting ||
    (Platform.OS === "ios" && (!purchasesReady || !selectedPkg));

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.headline}>{copy.headline}</Text>

        {!!tripTitle && !isManage ? <Text style={styles.tripLine}>For reisen: {tripTitle}</Text> : null}

        <Text style={styles.body}>{copy.body}</Text>

        {errorText ? <Text style={styles.warn}>{errorText}</Text> : null}

        {!isManage && packages.length > 0 ? (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.planTitle}>Velg abonnement</Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row" }}>
                {packages.map((pkg, idx) => {
                  const isSel = selectedPkg?.identifier === pkg.identifier;
                  const p = pkg?.product;

                  // ⚠️ priceString kommer fra produktet. Hvis alle packages peker på samme productId,
                  // vil alle vise samme pris (månedspris).
                  const price = p?.priceString || p?.localizedPriceString || "";

                  return (
                    <TouchableOpacity
                      key={pkg.identifier}
                      onPress={() => setSelectedPkg(pkg)}
                      style={[
                        styles.planPill,
                        isSel && styles.planPillSelected,
                        idx > 0 ? { marginLeft: 10 } : null
                      ]}
                    >
                      <Text style={[styles.planLabel, isSel && styles.planLabelSelected]}>
                        {labelForPackage(pkg)}
                      </Text>
                      <Text style={[styles.planPrice, isSel && styles.planLabelSelected]}>
                        {price} {suffixForPackage(pkg)}
                      </Text>
                      <Text style={styles.planSubtle}>{p?.identifier}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        ) : null}

        <View style={{ height: 18 }} />

        {!isManage ? (
          <TouchableOpacity
            disabled={ctaDisabled}
            onPress={onSubscribe}
            style={[styles.primaryButton, ctaDisabled && styles.buttonDisabled]}
          >
            {loading ? (
              <View style={styles.row}>
                <ActivityIndicator />
                <Text style={styles.primaryButtonText}>Kjøper…</Text>
              </View>
            ) : (
              <Text style={styles.primaryButtonText}>
                {booting ? "Laster…" : isPro ? "Allerede aktivt" : "Abonner for å låse opp"}
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            disabled={loading}
            onPress={onManageSubscriptions}
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
          >
            <Text style={styles.primaryButtonText}>Administrer abonnement</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          disabled={loading || booting}
          onPress={onRestore}
          style={[styles.secondaryButton, (loading || booting) && styles.buttonDisabled]}
        >
          <Text style={styles.secondaryButtonText}>Gjenopprett kjøp</Text>
        </TouchableOpacity>

        <TouchableOpacity
          disabled={loading}
          onPress={disablePro}
          style={[styles.ghostButton, loading && styles.buttonDisabled]}
        >
          <Text style={styles.ghostButtonText}>Debug: Skru av Pluss</Text>
        </TouchableOpacity>

        {/* Valgfritt: debug-linje */}
        {_rcDebug ? (
          <Text style={{ marginTop: 10, fontSize: 11, color: "#6b7280" }}>
            iOS:{String(_rcDebug.ios)} • expoGo:{String(_rcDebug.expoGo)} • hasKey:{String(_rcDebug.hasKey)} • ready:{String(purchasesReady)}
          </Text>
        ) : null}

        <TouchableOpacity disabled={loading} onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backText}>Ikke nå</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#022c22", justifyContent: "center", padding: 18 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4
  },
  headline: { fontSize: 24, fontWeight: "900", color: "#022c22" },
  tripLine: { marginTop: 8, color: "#4b5563" },
  body: { marginTop: 12, fontSize: 16, color: "#111827", opacity: 0.9, lineHeight: 22 },
  warn: { marginTop: 10, fontSize: 12, color: "#7f1d1d", fontWeight: "800" },
  planTitle: { fontSize: 13, fontWeight: "900", color: "#065f46", marginBottom: 8 },
  planPill: {
    width: 210,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(6,95,70,0.25)",
    backgroundColor: "rgba(2,44,34,0.04)"
  },
  planPillSelected: { borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,0.10)" },
  planLabel: { fontSize: 14, fontWeight: "900", color: "#022c22" },
  planPrice: { marginTop: 4, fontSize: 14, fontWeight: "900", color: "#065f46" },
  planLabelSelected: { color: "#065f46" },
  planSubtle: { marginTop: 6, fontSize: 11, color: "#6b7280" },
  row: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  primaryButton: { paddingVertical: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#16a34a" },
  primaryButtonText: { color: "#ecfdf5", fontSize: 16, fontWeight: "900" },
  secondaryButton: {
    marginTop: 10,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#16a34a",
    backgroundColor: "#fff"
  },
  secondaryButtonText: { color: "#16a34a", fontSize: 14, fontWeight: "800" },
  ghostButton: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "rgba(2,44,34,0.06)"
  },
  ghostButtonText: { color: "#065f46", fontSize: 13, fontWeight: "800" },
  backButton: { marginTop: 12, paddingVertical: 10, alignItems: "center" },
  backText: { color: "#6b7280", fontWeight: "700" },
  buttonDisabled: { opacity: 0.6 }
});
