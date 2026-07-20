#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return 1;

  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) return 1;

  char *macos = dirname(resolved);
  char bundle[PATH_MAX];
  snprintf(bundle, sizeof(bundle), "%s/../../..", macos);

  char script[PATH_MAX];
  snprintf(script, sizeof(script), "%s/reflect-os/scripts/launch-mac.command", bundle);
  execl("/bin/zsh", "zsh", "-l", script, (char *)NULL);
  return 1;
}
