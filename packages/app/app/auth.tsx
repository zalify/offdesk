import { useEffect } from "react";
import { router } from "expo-router";

import { LazyLoadingFallback } from "@/components/LazyLoadingFallback";

export default function AuthCallbackScreen() {
  useEffect(() => {
    router.replace("/");
  }, []);

  return <LazyLoadingFallback />;
}
