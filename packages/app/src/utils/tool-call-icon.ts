import type { ComponentType } from "react";
import {
  AlarmClock,
  Bell,
  Bot,
  Brain,
  CalendarClock,
  Clock,
  Eye,
  MessageSquare,
  MicVocal,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { resolveToolCallIconName, type ToolCallIcon } from "./tool-call-icon-name";

export type ToolCallIconComponent = ComponentType<{ size?: number; color?: string }>;

const ICON_COMPONENTS: Record<ToolCallIcon, ToolCallIconComponent> = {
  wrench: Wrench,
  square_terminal: SquareTerminal,
  eye: Eye,
  pencil: Pencil,
  search: Search,
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  mic_vocal: MicVocal,
  calendar_clock: CalendarClock,
  alarm_clock: AlarmClock,
  message_square: MessageSquare,
  bell: Bell,
  paseo: PaseoLogo,
  clock: Clock,
};

export function componentForToolCallIcon(name: ToolCallIcon): ToolCallIconComponent {
  return ICON_COMPONENTS[name];
}

export function resolveToolCallIcon(
  toolName: string,
  detail?: ToolCallDetail,
): ToolCallIconComponent {
  return componentForToolCallIcon(resolveToolCallIconName(toolName, detail));
}
