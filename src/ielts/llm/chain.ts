import { getFeedbackConfig } from "./config";
import type { FeedbackConfig, TaskId } from "./types";
export function chain(task: TaskId, config: FeedbackConfig = getFeedbackConfig()) {
  return config.providers.filter((provider) => provider.tasks.includes(task) && provider.baseURL.trim() && provider.model.trim());
}
