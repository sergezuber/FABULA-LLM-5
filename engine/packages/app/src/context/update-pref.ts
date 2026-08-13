import { createSignal } from "solid-js"
import { makePersisted } from "@solid-primitives/storage"

/**
 * May FABULA ask whether a newer release exists?
 *
 * ONE signal, created once here and imported by both the sidebar indicator and the Settings switch.
 * Two `makePersisted` calls under one name would have been the obvious shape and it is wrong in a way
 * that only shows up in use: they share the stored value but not the reactive one, so turning the check
 * off in Settings would leave the sidebar indicator lit until the window was reloaded.
 *
 * It also gates the only outbound request this application makes on its own. That is why the caller is
 * the gate rather than the route: with the switch off nothing is sent, instead of something being sent
 * and then ignored.
 */
export const [updateCheckEnabled, setUpdateCheckEnabled] = makePersisted(createSignal(true), {
  name: "fabula.updateCheck",
})
