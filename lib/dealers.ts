import directory from '../data/dealers.json';

export interface Dealer {
  name: string;
  phone: string;
}

const cities: Record<string, Dealer> = directory.cities;
const aliases: Record<string, string> = directory.aliases;

export function findDealer(city: string | null | undefined): Dealer | null {
  if (!city) return null;
  const key = city.trim().toLowerCase();
  return cities[aliases[key] ?? key] ?? null;
}
