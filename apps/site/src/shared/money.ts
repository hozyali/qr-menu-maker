// One price format for the owner dashboard and the public menu (Law 15).
// Prices are stored in the smallest unit (paisa), so 240000 is Rs 2,400.
export function formatMoney(amountMinor: number, currency = "PKR"): string {
  const amount = (amountMinor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency === "PKR" ? `Rs ${amount}` : `${currency} ${amount}`;
}
