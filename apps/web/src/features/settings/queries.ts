import type { Device, List } from "@loomcast/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * A single-use pairing code. Kept out of every cache: the dialog holds it in
 * state and the mutation is dropped as soon as nothing observes it.
 */
export function useCreatePairingCode() {
  return useMutation({
    mutationFn: () => api.request("devices.createPairingCode"),
    gcTime: 0,
  });
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (device: Device) => api.request("devices.revoke", { params: { id: device.id } }),
    onSuccess: (_, device) => {
      queryClient.setQueryData<List<Device>>(queryKeys.devices, (list) =>
        list ? { items: list.items.filter((item) => item.id !== device.id) } : list,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}
