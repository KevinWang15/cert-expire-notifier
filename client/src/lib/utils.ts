import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date | null): string {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeDate(date: string | Date | null): string {
  if (!date) return "N/A";
  const d = new Date(date);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `Expired ${Math.abs(diffDays)} days ago`;
  if (diffDays === 0) return "Expires today";
  if (diffDays === 1) return "Expires tomorrow";
  return `${diffDays} days left`;
}

export function getExpiryColor(date: string | Date | null): string {
  if (!date) return "text-muted-foreground";
  const d = new Date(date);
  const now = new Date();
  const diffDays = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return "text-red-600 font-bold";
  if (diffDays <= 7) return "text-red-500 font-semibold";
  if (diffDays <= 30) return "text-amber-500 font-semibold";
  return "text-green-600";
}
