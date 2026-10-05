# Sanitized host-probe fixture corpus

These files contain data-only, read-only captures for pure parser tests. Device
UUIDs, PCI addresses, PIDs, queue IDs, and counter values are synthetic. Process
names are removed or replaced with explicit synthetic placeholders. Argv,
usernames, hostnames, paths outside documented procfs/debugfs surfaces, tokens,
and environment data were removed.

Source formats are frozen to:

- Linux procfs documentation as emitted by Linux 6.8.0: `/proc/stat`,
  `/proc/meminfo`, and `/proc/<pid>/stat`.
- AMD System Management Interface 25.3.0+ede62f2, ROCm 6.4.0. The list,
  metric, and process JSON shapes correspond to `amd-smi` JSON output. The
  process capture preserves the reported 18,504,421,376-byte resident VRAM and
  1% CU-occupancy incident. The approved KFD manifest boundary represents the
  matching `vram_<gpuid>` evidence and exactly two captured `gpuid` files under
  `/sys/kernel/debug/kfd/proc/<pid>/queues/<queue>/`; all remain diagnostic-only.
- NVIDIA System Management Interface 550.54.15. Metrics use the documented
  `pci.bus_id,uuid,utilization.gpu,memory.used` CSV query; processes use
  `gpu_uuid,pid,used_gpu_memory`; the listing is the `-L` format used for MIG
  UUID discovery. The bounded XML process fixture covers documented zero-memory
  graphics (`G`) and MPS (`M`) contexts independently of utilization.

Failure JSON files are sanitized execution-result captures rather than vendor
stdout. They ensure missing tools, unsupported surfaces, permission failures,
and timeouts enter parsers as typed outcomes.

KFD policy: debugfs enumeration is not an atomic snapshot of queue lifetime,
PID start time, permission completeness, and stable KFD-to-PCI mapping.
Therefore KFD evidence is always `diagnostic-only` here. A vendor process or
memory surface can independently block admission; KFD alone degrades the
sample and never proves either idle or occupied admission state.
