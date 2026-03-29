/**
 * 루트 기본 모드에서 사용하는 대화 실행 본체.
 */

import type { BridgeClient } from '../client.js';
import { printResult } from '../output.js';
import { Spinner } from '../spinner.js';
import { c } from '../colors.js';
import {
  resolveModelId_func,
} from '../model-resolver.js';



export interface ExecOptions {
  client_var: BridgeClient;
  message_var: string;
  model_var?: string;
  resume_var?: string;
  async_var?: boolean;
  idle_timeout_var?: number;
  json_mode_var?: boolean;
  spinner_var?: Spinner;
}

export async function runExec_func(options_var: ExecOptions): Promise<void> {
  const client_var = options_var.client_var;
  const model_id_var = resolveModelId_func(options_var.model_var);
  const idle_timeout_var = options_var.idle_timeout_var ?? 10000;
  const json_mode_var = Boolean(options_var.json_mode_var);

  const spinner_var = options_var.spinner_var ?? new Spinner();
  let cascade_id_var: string;

  if (options_var.resume_var) {
    cascade_id_var = options_var.resume_var;
    spinner_var.update(`Sending message: ${cascade_id_var.substring(0, 8)}...`);
    const result_var = await client_var.post(`ls/send/${cascade_id_var}`, {
      text: options_var.message_var,
      model: model_id_var,
    });
    if (!result_var.success) throw new Error(result_var.error ?? 'send failed');
  } else {
    spinner_var.update('Creating cascade');
    const result_var = await client_var.post<string>('ls/create', {
      text: options_var.message_var,
      model: model_id_var,
    });
    if (!result_var.success) throw new Error(result_var.error ?? 'create failed');
    cascade_id_var = (result_var.data as string) ?? '';
    spinner_var.update(`Creating cascade: ${cascade_id_var.substring(0, 8)}...`);
  }

  // 백그라운드 UI 명시 반영 (Phase 10-6)
  const track_result_var = await client_var.post(`ls/track/${cascade_id_var}`, {});
  if (!track_result_var.success) {
    throw new Error(
      `Conversation created/sent but background UI tracking failed: ${track_result_var.error ?? 'track failed'}`,
    );
  }

  if (options_var.async_var) {
    spinner_var.succeed(`Cascade: ${cascade_id_var.substring(0, 8)}... (async)`);
    if (json_mode_var) {
      printResult({ cascadeId: cascade_id_var }, true);
    }
    return;
  }

  const start_time_var = Date.now();
  let step_count_var = 0;
  spinner_var.update('Waiting for response');

  // Poll cascade status directly (replaces fragile SSE monitoring)
  const poll_interval_ms_var = 2000;
  const max_wait_ms_var = idle_timeout_var * 30; // safety ceiling: 5 minutes at default 10s

  while (Date.now() - start_time_var < max_wait_ms_var) {
    await new Promise((r) => setTimeout(r, poll_interval_ms_var));

    try {
      const status_var = await client_var.get(`ls/conversation/${cascade_id_var}`);
      if (!status_var.success || !status_var.data) continue;

      const data_var = status_var.data as any;

      // Update step count from trajectory
      const steps_var = data_var?.trajectory?.steps;
      if (Array.isArray(steps_var) && steps_var.length > step_count_var) {
        step_count_var = steps_var.length;
        spinner_var.update(`Waiting for response (step ${step_count_var})`);
      }

      // Check if cascade is done
      if (data_var.status === 'CASCADE_RUN_STATUS_IDLE') {
        break;
      }
    } catch {
      // Ignore transient errors, keep polling
    }
  }

  const elapsed_var = ((Date.now() - start_time_var) / 1000).toFixed(1);
  spinner_var.succeed(`Done (${step_count_var} steps, ${elapsed_var}s)`);

  try {
    const conversation_var = await client_var.get(`ls/conversation/${cascade_id_var}`);
    if (conversation_var.success && conversation_var.data) {
      if (json_mode_var) {
        printResult(conversation_var.data, true);
        return;
      }

      const conversation_data_var = conversation_var.data as any;
      const steps_var = conversation_data_var?.trajectory?.steps ?? [];
      let response_text_var = '';
      for (let index_var = steps_var.length - 1; index_var >= 0; index_var -= 1) {
        const step_var = steps_var[index_var];
        if (step_var?.plannerResponse) {
          response_text_var = step_var.plannerResponse.response
            ?? step_var.plannerResponse.modifiedResponse
            ?? '';
          break;
        }
      }

      if (response_text_var) {
        process.stdout.write(`\n${response_text_var}\n`);
      } else {
        printResult(conversation_var.data, false);
      }
    }
  } catch {
    process.stderr.write(`  ${c.dim('(Failed to fetch response — check conversation by ID)')}\n`);
    if (json_mode_var) {
      printResult({ cascadeId: cascade_id_var }, true);
    }
  }
}
