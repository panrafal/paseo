import { Fragment } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { CodexBankedResetManagement } from "./banked-resets";
import { UsageCard } from "./card";
import type { UsageReportEntry } from "./types";

export function UsageList({
  serverId,
  reports,
}: {
  serverId: string;
  reports: UsageReportEntry[];
}) {
  return (
    <View style={settingsStyles.card}>
      {reports.map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <UsageCard serverId={serverId} entry={entry}>
            {entry.sourceId === "codex" ? (
              <CodexBankedResetManagement serverId={serverId} resets={entry.report.bankedResets} />
            ) : null}
          </UsageCard>
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
