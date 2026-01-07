router.post(
  "/revenuecat",
  express.json(), // <-- vanlig JSON, ikke raw
  async (req, res) => {
    try {
      const auth = req.headers.authorization;

      if (!auth || auth !== `Bearer ${process.env.REVENUECAT_WEBHOOK_TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized webhook" });
      }

      const event = req.body;
      const userId = event.app_user_id;
      const type = event.event?.type;

      if (!userId) {
        return res.json({ ok: true, ignored: true });
      }

      const activates = [
        "INITIAL_PURCHASE",
        "RENEWAL",
        "UNCANCELLATION",
        "PRODUCT_CHANGE"
      ];

      const deactivates = [
        "CANCELLATION",
        "EXPIRATION"
      ];

      if (activates.includes(type)) {
        await query(
          `UPDATE users SET is_premium = true WHERE id = $1`,
          [userId]
        );
      }

      if (deactivates.includes(type)) {
        await query(
          `UPDATE users
           SET is_premium = false
           WHERE id = $1 AND is_admin = false`,
          [userId]
        );
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error("RevenueCat webhook error:", e);
      return res.status(500).json({ error: "Webhook failed" });
    }
  }
);
