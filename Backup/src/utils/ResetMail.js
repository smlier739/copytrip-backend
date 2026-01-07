// Enkel HTML-mail
function resetEmailHtml({ resetUrl }) {
  return `
  <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height:1.4;">
    <h2>Nullstill passord</h2>
    <p>Trykk på knappen under for å velge nytt passord. Lenken varer i 1 time.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}"
         style="background:#16a34a;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;display:inline-block;">
        Nullstill passord
      </a>
    </p>
    <p>Hvis du ikke ba om dette, kan du ignorere e-posten.</p>
    <hr/>
    <p style="color:#6b7280;font-size:12px;">Grenseløs Reise</p>
  </div>
  `;
}

