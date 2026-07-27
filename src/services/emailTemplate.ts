export const renderEmailButton = (href: string, label: string): string => {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;">
      <tr>
        <td align="center" bgcolor="#111827" style="border-radius:6px;">
          <a href="${href}" style="display:inline-block; padding:12px 24px; font-family:Arial,sans-serif; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px;">${label}</a>
        </td>
      </tr>
    </table>`;
};

export const renderEmailShell = (innerHtml: string): string => {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb; margin:0; padding:0;">
      <tr>
        <td align="center" style="padding:24px;">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:8px;">
            <tr>
              <td style="padding:32px; font-family:Arial,sans-serif; color:#1f2937; font-size:16px; line-height:1.5; word-break:break-word; overflow-wrap:anywhere;">
                ${innerHtml}
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>`;
};
