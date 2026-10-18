import { useEffect } from "react";
import { router } from "expo-router";

import { BootScreen } from "@/components/BootScreen.web";

export default function AuthCallbackScreen() {
  useEffect(() => {
    router.replace("/");
  }, []);

  return <BootScreen step="signin" />;
}
