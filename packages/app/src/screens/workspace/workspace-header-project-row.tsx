import { GitBranch } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostBadge, HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";

const ThemedGitBranch = withUnistyles(GitBranch);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Which project the workspace belongs to, which machine it runs on, and which branch it is on.
 *
 * Compact gets the project and host on their own line under the workspace name. It still follows
 * the host's badge setting, so a purely local setup stays quiet. A project name that only repeats
 * the workspace name is dropped on wide and kept on compact. The branch follows the host.
 */
export function WorkspaceHeaderProjectRow({
  subtitle,
  isSubtitleDistinct,
  serverId,
  branchName,
}: {
  subtitle: string;
  isSubtitleDistinct: boolean;
  serverId: string;
  branchName: string | null;
}) {
  const isCompact = useIsCompactFormFactor();
  const hostBadge = useHostBadges({ enabled: isCompact }).get(serverId) ?? null;
  const showProject = isSubtitleDistinct || isCompact;
  if (!showProject && !hostBadge && !branchName) {
    return null;
  }
  return (
    <View style={styles.row}>
      {showProject ? (
        <Text testID="workspace-header-subtitle" style={styles.project} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {showProject && hostBadge ? <Text style={styles.separator}>·</Text> : null}
      {hostBadge ? <HostBadge badge={hostBadge} /> : null}
      {branchName && (showProject || hostBadge) ? (
        <Text style={styles.separator}>·</Text>
      ) : null}
      {branchName ? (
        <View style={styles.branch} testID="workspace-header-branch">
          <ThemedGitBranch size={HOST_BADGE_ICON_SIZE} uniProps={mutedColorMapping} />
          <Text style={styles.branchText} numberOfLines={1}>
            {branchName}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The compact header stretches this row to its available title width. Within that width,
  // the project truncates and HostBadge yields its label while retaining its fixed icon.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  project: {
    color: theme.colors.foregroundMuted,
    fontSize: {
      xs: theme.fontSize.sm,
      md: theme.fontSize.base,
    },
    flexShrink: 1,
    minWidth: 0,
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  branch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    maxWidth: "45%",
    flexShrink: 1,
  },
  branchText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
}));
