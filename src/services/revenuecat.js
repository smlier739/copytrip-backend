import axios from "axios";

const RC_API_KEY = process.env.REVENUECAT_SECRET_KEY; // ❗ SECRET key
const RC_PROJECT_ID = process.env.REVENUECAT_PROJECT_ID;

export async function getRevenueCatEntitlements(appUserId) {
  const url = `https://api.revenuecat.com/v1/subscribers/${appUserId}`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${RC_API_KEY}`,
      "X-Platform": "ios"
    }
  });

  return res.data?.subscriber?.entitlements?.active || {};
}
