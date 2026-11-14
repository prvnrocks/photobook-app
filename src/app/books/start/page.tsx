import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// M19 (D-071): the photos-first start page (D-070) is replaced by the creation wizard at
// /books/new. Old links / bookmarks land there; signed-out visitors go through login first.
export default async function StartBookPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fbooks%2Fnew");
  redirect("/books/new");
}
