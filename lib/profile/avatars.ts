// Catalog of profile avatars. PNGs live in /public/avatars/ — supplied by the
// frontend asset pack.

export type Avatar = {
  id: string;
  label: string;
  url: string;
};

const AVATARS: Avatar[] = [
  { id: "default",    label: "Default Pump.Bird", url: "/avatars/default.png" },
  { id: "sunglasses", label: "Shades",            url: "/avatars/sunglasses.png" },
  { id: "headband",   label: "Headband",          url: "/avatars/headband.png" },
  { id: "vr",         label: "VR Visor",          url: "/avatars/vr.png" },
  { id: "chain",      label: "Gold Chain",        url: "/avatars/chain.png" }
];

export function listAvatars(): Avatar[] {
  return AVATARS.slice();
}

export function defaultAvatarForWallet(wallet: string): string {
  let hash = 0;
  for (let i = 0; i < wallet.length; i += 1) {
    hash = (hash * 31 + wallet.charCodeAt(i)) >>> 0;
  }
  return AVATARS[hash % AVATARS.length].id;
}

export function avatarUrl(id: string | null | undefined): string {
  if (!id) return AVATARS[0].url;
  const found = AVATARS.find((a) => a.id === id);
  return found ? found.url : AVATARS[0].url;
}
