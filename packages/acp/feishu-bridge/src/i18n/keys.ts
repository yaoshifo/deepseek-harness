/**
 * Message keys ported 1:1 from cc-connect core/i18n/i18n.go (generated
 * by the M0 port script; regenerate against that file when it changes).
 *
 * @module dsh-feishu-bridge/i18n-keys
 */

/** Every message key value, in Go declaration order. */
export const ALL_MSG_KEYS = [
  'starting',
  'thinking',
  'tool',
  'tool_result',
  'tool_result_fmt_status',
  'tool_result_fmt_exit',
  'tool_result_fmt_no_output',
  'tool_result_fmt_ok',
  'tool_result_fmt_failed',
  'execution_stopped',
  'no_execution',
  'previous_processing',
  'queue_full',
  'message_queued',
  'cancel_queued_by_recall',
  'recall_already_processing',
  'attachment_recall_cancelled',
  'no_tools_allowed',
  'current_tools',
  'current_session',
  'tool_auth_not_supported',
  'tool_allow_failed',
  'tool_allowed_new',
  'error',
  'agent_process_exited',
  'agent_forwarded_hint',
  'session_not_found',
  'failed_to_start_agent_session',
  'failed_to_delete_session',
  'permission_prompt',
  'plan_content_header',
  'plan_content_header_revision',
  'permission_allowed',
  'permission_approve_all',
  'permission_denied_msg',
  'permission_expired',
  'permission_hint',
  'quiet_on',
  'quiet_off',
  'quiet_global_on',
  'quiet_global_off',
  'mode_changed',
  'mode_not_supported',
  'session_restarting',
  'session_not_started',
  'lang_changed',
  'lang_invalid',
  'lang_current',
  'unknown_command',
  'message_help',
  'help_title',
  'help_session_section',
  'help_agent_section',
  'help_tools_section',
  'help_system_section',
  'help_tip',
  'list_title',
  'list_title_paged',
  'list_empty',
  'list_more',
  'list_page_hint',
  'list_switch_hint',
  'list_error',
  'history_empty',
  'name_usage',
  'name_set',
  'name_no_session',
  'provider_not_supported',
  'provider_none',
  'provider_current',
  'provider_list_title',
  'provider_list_empty',
  'provider_switch_hint',
  'provider_not_found',
  'provider_need_new',
  'provider_switched',
  'provider_shortcut_new',
  'provider_cleared',
  'provider_hot_switched',
  'provider_added',
  'provider_add_usage',
  'provider_add_failed',
  'provider_removed',
  'provider_remove_failed',
  'card_title_provider_add',
  'provider_add_pick_hint',
  'provider_add_other',
  'provider_add_api_key_prompt',
  'provider_add_invite_hint',
  'provider_link_global',
  'provider_linked',
  'voice_not_enabled',
  'voice_using_platform_recognition',
  'voice_no_ffmpeg',
  'voice_transcribing',
  'voice_transcribed',
  'voice_transcribe_failed',
  'voice_empty',
  'tts_not_enabled',
  'tts_status',
  'tts_switched',
  'tts_usage',
  'heartbeat_not_available',
  'heartbeat_status',
  'heartbeat_paused',
  'heartbeat_resumed',
  'heartbeat_interval',
  'heartbeat_triggered',
  'heartbeat_usage',
  'heartbeat_invalid_mins',
  'cron_not_available',
  'cron_usage',
  'cron_add_usage',
  'cron_added',
  'cron_added_exec',
  'cron_addexec_usage',
  'cron_empty',
  'cron_list_title',
  'cron_list_footer',
  'cron_del_usage',
  'cron_deleted',
  'cron_not_found',
  'cron_enabled',
  'cron_disabled',
  'cron_muted',
  'cron_unmuted',
  'cron_card_hint',
  'cron_next_short',
  'cron_last_short',
  'cron_btn_enable',
  'cron_btn_disable',
  'cron_btn_mute',
  'cron_btn_unmute',
  'cron_btn_delete',
  'status_title',
  'reply_footer_remaining',
  'model_current',
  'model_changed',
  'model_change_failed',
  'model_card_switching',
  'model_card_switched',
  'model_card_switch_failed',
  'model_not_supported',
  'reasoning_current',
  'reasoning_changed',
  'reasoning_not_supported',
  'compress_not_supported',
  'compressing',
  'compress_no_session',
  'compress_done',
  'context_compacted',
  'context_compacted_fmt',
  'memory_not_supported',
  'memory_show_project',
  'memory_show_global',
  'memory_empty',
  'memory_added',
  'memory_add_failed',
  'memory_add_usage',
  'usage_not_supported',
  'usage_fetch_failed',
  'status_mode',
  'status_session',
  'status_cron',
  'status_thinking_messages',
  'status_tool_messages',
  'status_session_key',
  'status_agent_sid',
  'status_user_id',
  'enabled_short',
  'disabled_short',
  'model_default',
  'model_list_title',
  'model_usage',
  'reasoning_default',
  'reasoning_list_title',
  'reasoning_usage',
  'reasoning_select_placeholder',
  'mode_usage',
  'lang_select_placeholder',
  'model_select_placeholder',
  'mode_select_placeholder',
  'provider_select_placeholder',
  'provider_clear_option',
  'card_back',
  'card_prev',
  'card_next',
  'card_title_status',
  'card_title_language',
  'card_title_model',
  'card_title_reasoning',
  'card_title_mode',
  'card_title_sessions',
  'card_title_sessions_paged',
  'card_title_current_session',
  'card_title_history',
  'card_title_history_last',
  'card_title_provider',
  'card_title_cron',
  'card_title_heartbeat',
  'card_title_commands',
  'card_title_alias',
  'card_title_config',
  'card_title_skills',
  'card_title_doctor',
  'card_title_version',
  'card_title_upgrade',
  'list_item',
  'list_empty_summary',
  'cron_id_label',
  'cron_failed_suffix',
  'commands_tag_agent',
  'commands_tag_shell',
  'upgrade_timeout_suffix',
  'cron_schedule_label',
  'cron_next_run_label',
  'cron_last_run_label',
  'perm_btn_allow',
  'perm_btn_deny',
  'perm_btn_allow_all',
  'plan_export_btn',
  'render_status_rendering',
  'render_status_delivered',
  'render_status_cancelled',
  'render_status_failed',
  'render_tag_plan',
  'render_tag_reply',
  'perm_card_title',
  'perm_card_body',
  'perm_deny_reason_placeholder',
  'ask_question_title',
  'ask_question_multi',
  'ask_question_answered',
  'commands_title',
  'commands_empty',
  'commands_hint',
  'commands_usage',
  'commands_add_usage',
  'commands_addexec_usage',
  'commands_added',
  'commands_exec_added',
  'commands_add_exists',
  'commands_del_usage',
  'commands_deleted',
  'commands_not_found',
  'command_exec_timeout',
  'command_exec_error',
  'command_exec_success',
  'skills_title',
  'skills_empty',
  'skills_hint',
  'config_title',
  'config_hint',
  'config_get_usage',
  'config_set_usage',
  'config_updated',
  'config_key_not_found',
  'config_reloaded',
  'doctor_running',
  'doctor_title',
  'doctor_summary',
  'restarting',
  'restart_success',
  'upgrade_checking',
  'upgrade_up_to_date',
  'upgrade_available',
  'upgrade_downloading',
  'upgrade_success',
  'upgrade_dev_build',
  'web_not_supported',
  'web_not_enabled',
  'web_setup_success',
  'web_need_restart',
  'web_status',
  'alias_empty',
  'alias_list_header',
  'alias_added',
  'alias_deleted',
  'alias_not_found',
  'alias_usage',
  'turn_completed',
  'processing',
  'bg_task_running',
  'bg_task_processing',
  'new_session_created',
  'new_session_created_name',
  'active_session_count',
  'session_auto_reset_idle',
  'session_closing_graceful',
  'delete_usage',
  'delete_success',
  'delete_active_denied',
  'delete_not_supported',
  'delete_mode_title',
  'delete_mode_select',
  'delete_mode_selected',
  'delete_mode_selected_count',
  'delete_mode_delete_selected',
  'delete_mode_cancel',
  'delete_mode_confirm_title',
  'delete_mode_confirm_button',
  'delete_mode_back_button',
  'delete_mode_empty_selection',
  'delete_mode_result_title',
  'delete_mode_deleting_title',
  'delete_mode_deleting_body',
  'delete_mode_missing_session',
  'switch_success',
  'switch_no_match',
  'switch_no_session',
  'switch_resend_title',
  'switch_resend_header',
  'command_timeout',
  'stall_retry',
  'stall_timeout',
  'watchdog_reset',
  'banned_word_blocked',
  'command_disabled',
  'admin_required',
  'rate_limited',
  'err_provider_model_unavailable',
  'err_provider_auth',
  'err_provider_quota',
  'err_provider_rate_limit',
  'err_provider_network',
  'err_provider_timeout',
  'empty_result',
  'empty_result_with_reason',
  'btw_sent',
  'btw_send_failed',
  'btw_empty',
  'btw_timeout',
  'btw_no_session',
  'ps_sent',
  'silent_reply',
  'ps_send_failed',
  'ps_empty',
  'ps_no_session',
  'whoami_title',
  'whoami_card_title',
  'whoami_name',
  'whoami_platform',
  'whoami_usage',
  'relay_no_binding',
  'relay_bound',
  'relay_bind_removed',
  'relay_bind_not_found',
  'relay_bind_success',
  'relay_usage',
  'relay_not_available',
  'relay_unbound',
  'relay_bind_self',
  'relay_not_found',
  'relay_no_target',
  'relay_setup_hint',
  'relay_setup_ok',
  'relay_setup_exists',
  'relay_setup_no_memory',
  'setup_native',
  'cron_setup_ok',
  'search_usage',
  'search_error',
  'search_no_result',
  'search_result',
  'search_hint',
  'new',
  'list',
  'search',
  'switch',
  'delete',
  'name',
  'current',
  'history',
  'provider',
  'memory',
  'allow',
  'model',
  'reasoning',
  'mode',
  'lang',
  'quiet',
  'compress',
  'stop',
  'cron',
  'commands',
  'alias',
  'skills',
  'config',
  'doctor',
  'upgrade',
  'restart',
  'status',
  'usage',
  'version',
  'help',
  'bind',
  'shell',
  'dir',
  'monitor',
  'diff',
  'ps',
  'diff_empty',
  'diff_no_diff2html',
  'dir_changed',
  'dir_current',
  'dir_reset',
  'dir_usage',
  'monitor_usage',
  'monitor_disabled',
  'monitor_added',
  'monitor_already',
  'monitor_removed',
  'monitor_not_in_list',
  'monitor_list_title',
  'monitor_list_empty',
  'monitor_star_mode',
  'monitor_save_failed',
  'monitor_no_chat',
  'monitor_mode_usage',
  'monitor_mode_current',
  'monitor_mode_set',
  'monitor_mode_bad',
  'monitor_mode_no_dirs',
  'monitor_dispatch_group_name',
  'monitor_mode_set_dispatch_hub',
  'monitor_spawn_failed',
  'monitor_clarify_timeout',
  'monitor_clarify_cancelled',
  'monitor_pull_group_title',
  'monitor_dispatch_title',
  'monitor_jump_btn',
  'dir_not_supported',
  'dir_invalid_path',
  'dir_history_title',
  'dir_history_hint',
  'dir_invalid_index',
  'dir_no_history',
  'dir_no_previous',
  'dir_card_title',
  'dir_card_page_hint',
  'dir_card_empty_history',
  'dir_card_reset',
  'dir_card_prev',
  'dir_session_reset',
  'show',
  'show_usage',
  'show_parse_error',
  'show_not_found',
  'show_dir_with_location',
  'show_read_failed',
  'ws_not_enabled',
  'ws_no_binding',
  'ws_info',
  'ws_info_shared',
  'ws_usage',
  'ws_init_usage',
  'ws_bind_usage',
  'ws_bind_success',
  'ws_bind_not_found',
  'ws_route_usage',
  'ws_route_success',
  'ws_route_absolute_required',
  'ws_route_not_found',
  'ws_route_not_directory',
  'ws_unbind_success',
  'ws_list_empty',
  'ws_list_title',
  'ws_shared_no_binding',
  'ws_shared_usage',
  'ws_shared_bind_success',
  'ws_shared_route_success',
  'ws_shared_unbind_success',
  'ws_shared_list_empty',
  'ws_shared_list_title',
  'ws_shared_only_hint',
  'ws_not_found_hint',
  'ws_resolution_error',
  'ws_clone_progress',
  'ws_clone_success',
  'ws_clone_failed',
  'ws_init_dir_not_found',
  'ws_init_invalid_target',
  'background_auto_denied',
  'spawn_usage',
  'spawn_not_supported',
  'spawn_error',
  'spawn_dir_error',
  'spawn_group_ready',
  'spawn_memory_warn_title',
  'spawn_memory_warn',
  'spawn_memory_block_title',
  'spawn_memory_block',
  'fork_group_ready',
  'fork_no_context',
  'spawn_unknown_flag',
  'fork_unknown_flag',
  'fork_cross_workdir_degraded',
  'session_resume_degraded',
  'fork_at_truncate_failed',
  'fork_at_not_supported',
  'done_unknown_flag',
  'provider_unknown_flag',
  'rename_spawned_only',
  'rename_not_supported',
  'rename_no_history',
  'rename_backend_not_supported',
  'rename_unchanged',
  'rename_failed',
  'rename_error',
  'rename_done',
  'done_not_supported',
  'done_error',
  'done_reply_no_parent',
  'done_private_not_allowed',
  'subtask_send_not_child',
  'subtask_followup_header',
  'subtask_child_busy',
  'done_recursive_summary',
  'done_dirty_children',
  'subtask_diff_summary',
  'subtask_timeout',
  'subtask_gather_no_pending',
  'dash_done_tip',
  'dash_done_dirty',
  'worktree_not_git',
  'worktree_create_error',
  'worktree_removed',
  'worktree_removed_short',
  'worktree_kept',
  'worktree_dirty_prompt',
  'worktree_card_title',
  'worktree_keep_btn',
  'worktree_remove_btn',
  'worktree_orphan_cleaned',
  'worktree_orphan_kept',
  'worktree_orphan_dir_label',
  'worktree_memory_warn',
  'done_reply_parent_header',
  'notify_no_children',
  'tag_not_supported',
  'tag_error',
  'undone_not_supported',
  'undone_error',
  'untag_not_supported',
  'untag_error',
  'spawn',
  'fork',
  'done',
  'notify',
  'board',
  'chatroom',
  'chatroom_usage',
  'fork_usage',
  'done_usage',
  'notify_usage',
  'new_usage',
  'list_usage',
  'history_usage',
  'allow_usage',
  'upgrade_usage',
  'web_usage',
  'diff_usage',
  'btw_usage',
  'ps_usage',
  'board_usage',
  'switch_usage',
  'shell_usage',
  'provider_usage',
  'lang_usage',
  'help_unknown_cmd',
  'help_no_usage',
  'btw',
  'web',
  'hints_empty',
  'hint',
  'attachments_staged',
  'attachments_discarded',
  'chatroom_ready',
  'chatroom_topic_label',
  'chatroom_unknown_role',
  'chatroom_ask_header',
  'chatroom_ask_not_in_room',
  'chatroom_role_not_found',
  'chatroom_reminder',
  'chatroom_role_reply_header',
  'chatroom_gather_timed_out_dispatched',
  'chatroom_gather_timed_out_in_flight',
  'chatroom_gather_timed_out_idle',
  'chatroom_research_progress_title',
  'chatroom_research_progress_body',
  'chatroom_research_progress_done',
  'chatroom_research_progress_timed_out',
  'chatroom_research_progress_timed_out_title',
  'chatroom_max_rounds_range',
  'chatroom_research_single_role',
  'chatroom_research_ask_timeout',
  'chatroom_pending_header',
  'chatroom_pending_body',
  'chatroom_concluded',
  'chatroom_no_roles',
  'chatroom_no_roles_configured',
  'chatroom_research_needs_uv',
  'chatroom_list_title',
  'chatroom_role_inited',
  'chatroom_gather_header',
  'chatroom_gather_timeout',
  'chatroom_direct_started',
  'chatroom_pick_title',
  'chatroom_pick_recommended',
  'chatroom_pick_select',
  'chatroom_pick_selected',
  'chatroom_pick_selected_count',
  'chatroom_pick_confirm',
  'chatroom_pick_cancel',
  'chatroom_pick_cancelled',
  'chatroom_pick_empty',
  'chatroom_pick_too_many',
  'chatroom_pick_picking',
  'chatroom_pick_starting',
  'chatroom_topic_pick_title',
  'chatroom_topic_pick_picking',
  'chatroom_topic_pick_pick',
  'chatroom_topic_pick_picked',
  'chatroom_topic_pick_picked_hint',
  'chatroom_topic_pick_not_selected',
  'chatroom_topic_pick_confirm',
  'chatroom_topic_pick_cancel',
  'chatroom_topic_pick_cancelled',
  'chatroom_topic_pick_empty',
  'chatroom_topic_pick_starting',
  'chatroom_topic_pick_watchdog_hint',
  'chatroom_gather_ask_human_blocked',
] as const

/** Message key union (all Go MsgKey constant values). */
export type MsgKey = (typeof ALL_MSG_KEYS)[number]

export const MsgStarting: MsgKey = 'starting'
export const MsgThinking: MsgKey = 'thinking'
export const MsgTool: MsgKey = 'tool'
export const MsgToolResult: MsgKey = 'tool_result'
export const MsgToolResultFmtStatus: MsgKey = 'tool_result_fmt_status'
export const MsgToolResultFmtExit: MsgKey = 'tool_result_fmt_exit'
export const MsgToolResultFmtNoOutput: MsgKey = 'tool_result_fmt_no_output'
export const MsgToolResultFmtOk: MsgKey = 'tool_result_fmt_ok'
export const MsgToolResultFmtFailed: MsgKey = 'tool_result_fmt_failed'
export const MsgExecutionStopped: MsgKey = 'execution_stopped'
export const MsgNoExecution: MsgKey = 'no_execution'
export const MsgPreviousProcessing: MsgKey = 'previous_processing'
export const MsgQueueFull: MsgKey = 'queue_full'
export const MsgMessageQueued: MsgKey = 'message_queued'
export const MsgCancelQueuedByRecall: MsgKey = 'cancel_queued_by_recall'
export const MsgRecallAlreadyProcessing: MsgKey = 'recall_already_processing'
export const MsgAttachmentRecallCancelled: MsgKey = 'attachment_recall_cancelled'
export const MsgNoToolsAllowed: MsgKey = 'no_tools_allowed'
export const MsgCurrentTools: MsgKey = 'current_tools'
export const MsgCurrentSession: MsgKey = 'current_session'
export const MsgToolAuthNotSupported: MsgKey = 'tool_auth_not_supported'
export const MsgToolAllowFailed: MsgKey = 'tool_allow_failed'
export const MsgToolAllowedNew: MsgKey = 'tool_allowed_new'
export const MsgError: MsgKey = 'error'
export const MsgAgentProcessExited: MsgKey = 'agent_process_exited'
export const MsgAgentForwardedHint: MsgKey = 'agent_forwarded_hint'
export const MsgSessionNotFound: MsgKey = 'session_not_found'
export const MsgFailedToStartAgentSession: MsgKey = 'failed_to_start_agent_session'
export const MsgFailedToDeleteSession: MsgKey = 'failed_to_delete_session'
export const MsgPermissionPrompt: MsgKey = 'permission_prompt'
export const MsgPlanContentHeader: MsgKey = 'plan_content_header'
export const MsgPlanContentHeaderRevision: MsgKey = 'plan_content_header_revision'
export const MsgPermissionAllowed: MsgKey = 'permission_allowed'
export const MsgPermissionApproveAll: MsgKey = 'permission_approve_all'
export const MsgPermissionDenied: MsgKey = 'permission_denied_msg'
export const MsgPermissionExpired: MsgKey = 'permission_expired'
export const MsgPermissionHint: MsgKey = 'permission_hint'
export const MsgQuietOn: MsgKey = 'quiet_on'
export const MsgQuietOff: MsgKey = 'quiet_off'
export const MsgQuietGlobalOn: MsgKey = 'quiet_global_on'
export const MsgQuietGlobalOff: MsgKey = 'quiet_global_off'
export const MsgModeChanged: MsgKey = 'mode_changed'
export const MsgModeNotSupported: MsgKey = 'mode_not_supported'
export const MsgSessionRestarting: MsgKey = 'session_restarting'
export const MsgSessionNotStarted: MsgKey = 'session_not_started'
export const MsgLangChanged: MsgKey = 'lang_changed'
export const MsgLangInvalid: MsgKey = 'lang_invalid'
export const MsgLangCurrent: MsgKey = 'lang_current'
export const MsgUnknownCommand: MsgKey = 'unknown_command'
export const MsgHelp: MsgKey = 'message_help'
export const MsgHelpTitle: MsgKey = 'help_title'
export const MsgHelpSessionSection: MsgKey = 'help_session_section'
export const MsgHelpAgentSection: MsgKey = 'help_agent_section'
export const MsgHelpToolsSection: MsgKey = 'help_tools_section'
export const MsgHelpSystemSection: MsgKey = 'help_system_section'
export const MsgHelpTip: MsgKey = 'help_tip'
export const MsgListTitle: MsgKey = 'list_title'
export const MsgListTitlePaged: MsgKey = 'list_title_paged'
export const MsgListEmpty: MsgKey = 'list_empty'
export const MsgListMore: MsgKey = 'list_more'
export const MsgListPageHint: MsgKey = 'list_page_hint'
export const MsgListSwitchHint: MsgKey = 'list_switch_hint'
export const MsgListError: MsgKey = 'list_error'
export const MsgHistoryEmpty: MsgKey = 'history_empty'
export const MsgNameUsage: MsgKey = 'name_usage'
export const MsgNameSet: MsgKey = 'name_set'
export const MsgNameNoSession: MsgKey = 'name_no_session'
export const MsgProviderNotSupported: MsgKey = 'provider_not_supported'
export const MsgProviderNone: MsgKey = 'provider_none'
export const MsgProviderCurrent: MsgKey = 'provider_current'
export const MsgProviderListTitle: MsgKey = 'provider_list_title'
export const MsgProviderListEmpty: MsgKey = 'provider_list_empty'
export const MsgProviderSwitchHint: MsgKey = 'provider_switch_hint'
export const MsgProviderNotFound: MsgKey = 'provider_not_found'
export const MsgProviderNeedNew: MsgKey = 'provider_need_new'
export const MsgProviderSwitched: MsgKey = 'provider_switched'
export const MsgProviderShortcutNew: MsgKey = 'provider_shortcut_new'
export const MsgProviderCleared: MsgKey = 'provider_cleared'
export const MsgProviderHotSwitched: MsgKey = 'provider_hot_switched'
export const MsgProviderAdded: MsgKey = 'provider_added'
export const MsgProviderAddUsage: MsgKey = 'provider_add_usage'
export const MsgProviderAddFailed: MsgKey = 'provider_add_failed'
export const MsgProviderRemoved: MsgKey = 'provider_removed'
export const MsgProviderRemoveFailed: MsgKey = 'provider_remove_failed'
export const MsgCardTitleProviderAdd: MsgKey = 'card_title_provider_add'
export const MsgProviderAddPickHint: MsgKey = 'provider_add_pick_hint'
export const MsgProviderAddOther: MsgKey = 'provider_add_other'
export const MsgProviderAddApiKeyPrompt: MsgKey = 'provider_add_api_key_prompt'
export const MsgProviderAddInviteHint: MsgKey = 'provider_add_invite_hint'
export const MsgProviderLinkGlobal: MsgKey = 'provider_link_global'
export const MsgProviderLinked: MsgKey = 'provider_linked'
export const MsgVoiceNotEnabled: MsgKey = 'voice_not_enabled'
export const MsgVoiceUsingPlatformRecognition: MsgKey = 'voice_using_platform_recognition'
export const MsgVoiceNoFFmpeg: MsgKey = 'voice_no_ffmpeg'
export const MsgVoiceTranscribing: MsgKey = 'voice_transcribing'
export const MsgVoiceTranscribed: MsgKey = 'voice_transcribed'
export const MsgVoiceTranscribeFailed: MsgKey = 'voice_transcribe_failed'
export const MsgVoiceEmpty: MsgKey = 'voice_empty'
export const MsgTTSNotEnabled: MsgKey = 'tts_not_enabled'
export const MsgTTSStatus: MsgKey = 'tts_status'
export const MsgTTSSwitched: MsgKey = 'tts_switched'
export const MsgTTSUsage: MsgKey = 'tts_usage'
export const MsgHeartbeatNotAvailable: MsgKey = 'heartbeat_not_available'
export const MsgHeartbeatStatus: MsgKey = 'heartbeat_status'
export const MsgHeartbeatPaused: MsgKey = 'heartbeat_paused'
export const MsgHeartbeatResumed: MsgKey = 'heartbeat_resumed'
export const MsgHeartbeatInterval: MsgKey = 'heartbeat_interval'
export const MsgHeartbeatTriggered: MsgKey = 'heartbeat_triggered'
export const MsgHeartbeatUsage: MsgKey = 'heartbeat_usage'
export const MsgHeartbeatInvalidMins: MsgKey = 'heartbeat_invalid_mins'
export const MsgCronNotAvailable: MsgKey = 'cron_not_available'
export const MsgCronUsage: MsgKey = 'cron_usage'
export const MsgCronAddUsage: MsgKey = 'cron_add_usage'
export const MsgCronAdded: MsgKey = 'cron_added'
export const MsgCronAddedExec: MsgKey = 'cron_added_exec'
export const MsgCronAddExecUsage: MsgKey = 'cron_addexec_usage'
export const MsgCronEmpty: MsgKey = 'cron_empty'
export const MsgCronListTitle: MsgKey = 'cron_list_title'
export const MsgCronListFooter: MsgKey = 'cron_list_footer'
export const MsgCronDelUsage: MsgKey = 'cron_del_usage'
export const MsgCronDeleted: MsgKey = 'cron_deleted'
export const MsgCronNotFound: MsgKey = 'cron_not_found'
export const MsgCronEnabled: MsgKey = 'cron_enabled'
export const MsgCronDisabled: MsgKey = 'cron_disabled'
export const MsgCronMuted: MsgKey = 'cron_muted'
export const MsgCronUnmuted: MsgKey = 'cron_unmuted'
export const MsgCronCardHint: MsgKey = 'cron_card_hint'
export const MsgCronNextShort: MsgKey = 'cron_next_short'
export const MsgCronLastShort: MsgKey = 'cron_last_short'
export const MsgCronBtnEnable: MsgKey = 'cron_btn_enable'
export const MsgCronBtnDisable: MsgKey = 'cron_btn_disable'
export const MsgCronBtnMute: MsgKey = 'cron_btn_mute'
export const MsgCronBtnUnmute: MsgKey = 'cron_btn_unmute'
export const MsgCronBtnDelete: MsgKey = 'cron_btn_delete'
export const MsgStatusTitle: MsgKey = 'status_title'
export const MsgReplyFooterRemaining: MsgKey = 'reply_footer_remaining'
export const MsgModelCurrent: MsgKey = 'model_current'
export const MsgModelChanged: MsgKey = 'model_changed'
export const MsgModelChangeFailed: MsgKey = 'model_change_failed'
export const MsgModelCardSwitching: MsgKey = 'model_card_switching'
export const MsgModelCardSwitched: MsgKey = 'model_card_switched'
export const MsgModelCardSwitchFailed: MsgKey = 'model_card_switch_failed'
export const MsgModelNotSupported: MsgKey = 'model_not_supported'
export const MsgReasoningCurrent: MsgKey = 'reasoning_current'
export const MsgReasoningChanged: MsgKey = 'reasoning_changed'
export const MsgReasoningNotSupported: MsgKey = 'reasoning_not_supported'
export const MsgCompressNotSupported: MsgKey = 'compress_not_supported'
export const MsgCompressing: MsgKey = 'compressing'
export const MsgCompressNoSession: MsgKey = 'compress_no_session'
export const MsgCompressDone: MsgKey = 'compress_done'
export const MsgContextCompacted: MsgKey = 'context_compacted'
export const MsgContextCompactedFmt: MsgKey = 'context_compacted_fmt'
export const MsgMemoryNotSupported: MsgKey = 'memory_not_supported'
export const MsgMemoryShowProject: MsgKey = 'memory_show_project'
export const MsgMemoryShowGlobal: MsgKey = 'memory_show_global'
export const MsgMemoryEmpty: MsgKey = 'memory_empty'
export const MsgMemoryAdded: MsgKey = 'memory_added'
export const MsgMemoryAddFailed: MsgKey = 'memory_add_failed'
export const MsgMemoryAddUsage: MsgKey = 'memory_add_usage'
export const MsgUsageNotSupported: MsgKey = 'usage_not_supported'
export const MsgUsageFetchFailed: MsgKey = 'usage_fetch_failed'
export const MsgStatusMode: MsgKey = 'status_mode'
export const MsgStatusSession: MsgKey = 'status_session'
export const MsgStatusCron: MsgKey = 'status_cron'
export const MsgStatusThinkingMessages: MsgKey = 'status_thinking_messages'
export const MsgStatusToolMessages: MsgKey = 'status_tool_messages'
export const MsgStatusSessionKey: MsgKey = 'status_session_key'
export const MsgStatusAgentSID: MsgKey = 'status_agent_sid'
export const MsgStatusUserID: MsgKey = 'status_user_id'
export const MsgEnabledShort: MsgKey = 'enabled_short'
export const MsgDisabledShort: MsgKey = 'disabled_short'
export const MsgModelDefault: MsgKey = 'model_default'
export const MsgModelListTitle: MsgKey = 'model_list_title'
export const MsgModelUsage: MsgKey = 'model_usage'
export const MsgReasoningDefault: MsgKey = 'reasoning_default'
export const MsgReasoningListTitle: MsgKey = 'reasoning_list_title'
export const MsgReasoningUsage: MsgKey = 'reasoning_usage'
export const MsgReasoningSelectPlaceholder: MsgKey = 'reasoning_select_placeholder'
export const MsgModeUsage: MsgKey = 'mode_usage'
export const MsgLangSelectPlaceholder: MsgKey = 'lang_select_placeholder'
export const MsgModelSelectPlaceholder: MsgKey = 'model_select_placeholder'
export const MsgModeSelectPlaceholder: MsgKey = 'mode_select_placeholder'
export const MsgProviderSelectPlaceholder: MsgKey = 'provider_select_placeholder'
export const MsgProviderClearOption: MsgKey = 'provider_clear_option'
export const MsgCardBack: MsgKey = 'card_back'
export const MsgCardPrev: MsgKey = 'card_prev'
export const MsgCardNext: MsgKey = 'card_next'
export const MsgCardTitleStatus: MsgKey = 'card_title_status'
export const MsgCardTitleLanguage: MsgKey = 'card_title_language'
export const MsgCardTitleModel: MsgKey = 'card_title_model'
export const MsgCardTitleReasoning: MsgKey = 'card_title_reasoning'
export const MsgCardTitleMode: MsgKey = 'card_title_mode'
export const MsgCardTitleSessions: MsgKey = 'card_title_sessions'
export const MsgCardTitleSessionsPaged: MsgKey = 'card_title_sessions_paged'
export const MsgCardTitleCurrentSession: MsgKey = 'card_title_current_session'
export const MsgCardTitleHistory: MsgKey = 'card_title_history'
export const MsgCardTitleHistoryLast: MsgKey = 'card_title_history_last'
export const MsgCardTitleProvider: MsgKey = 'card_title_provider'
export const MsgCardTitleCron: MsgKey = 'card_title_cron'
export const MsgCardTitleHeartbeat: MsgKey = 'card_title_heartbeat'
export const MsgCardTitleCommands: MsgKey = 'card_title_commands'
export const MsgCardTitleAlias: MsgKey = 'card_title_alias'
export const MsgCardTitleConfig: MsgKey = 'card_title_config'
export const MsgCardTitleSkills: MsgKey = 'card_title_skills'
export const MsgCardTitleDoctor: MsgKey = 'card_title_doctor'
export const MsgCardTitleVersion: MsgKey = 'card_title_version'
export const MsgCardTitleUpgrade: MsgKey = 'card_title_upgrade'
export const MsgListItem: MsgKey = 'list_item'
export const MsgListEmptySummary: MsgKey = 'list_empty_summary'
export const MsgCronIDLabel: MsgKey = 'cron_id_label'
export const MsgCronFailedSuffix: MsgKey = 'cron_failed_suffix'
export const MsgCommandsTagAgent: MsgKey = 'commands_tag_agent'
export const MsgCommandsTagShell: MsgKey = 'commands_tag_shell'
export const MsgUpgradeTimeoutSuffix: MsgKey = 'upgrade_timeout_suffix'
export const MsgCronScheduleLabel: MsgKey = 'cron_schedule_label'
export const MsgCronNextRunLabel: MsgKey = 'cron_next_run_label'
export const MsgCronLastRunLabel: MsgKey = 'cron_last_run_label'
export const MsgPermBtnAllow: MsgKey = 'perm_btn_allow'
export const MsgPermBtnDeny: MsgKey = 'perm_btn_deny'
export const MsgPermBtnAllowAll: MsgKey = 'perm_btn_allow_all'
export const MsgPlanExportBtn: MsgKey = 'plan_export_btn'
export const MsgRenderStatusRendering: MsgKey = 'render_status_rendering'
export const MsgRenderStatusDelivered: MsgKey = 'render_status_delivered'
export const MsgRenderStatusCancelled: MsgKey = 'render_status_cancelled'
export const MsgRenderStatusFailed: MsgKey = 'render_status_failed'
export const MsgRenderTagPlan: MsgKey = 'render_tag_plan'
export const MsgRenderTagReply: MsgKey = 'render_tag_reply'
export const MsgPermCardTitle: MsgKey = 'perm_card_title'
export const MsgPermCardBody: MsgKey = 'perm_card_body'
export const MsgPermDenyReasonPlaceholder: MsgKey = 'perm_deny_reason_placeholder'
export const MsgAskQuestionTitle: MsgKey = 'ask_question_title'
export const MsgAskQuestionMulti: MsgKey = 'ask_question_multi'
export const MsgAskQuestionAnswered: MsgKey = 'ask_question_answered'
export const MsgCommandsTitle: MsgKey = 'commands_title'
export const MsgCommandsEmpty: MsgKey = 'commands_empty'
export const MsgCommandsHint: MsgKey = 'commands_hint'
export const MsgCommandsUsage: MsgKey = 'commands_usage'
export const MsgCommandsAddUsage: MsgKey = 'commands_add_usage'
export const MsgCommandsAddExecUsage: MsgKey = 'commands_addexec_usage'
export const MsgCommandsAdded: MsgKey = 'commands_added'
export const MsgCommandsExecAdded: MsgKey = 'commands_exec_added'
export const MsgCommandsAddExists: MsgKey = 'commands_add_exists'
export const MsgCommandsDelUsage: MsgKey = 'commands_del_usage'
export const MsgCommandsDeleted: MsgKey = 'commands_deleted'
export const MsgCommandsNotFound: MsgKey = 'commands_not_found'
export const MsgCommandExecTimeout: MsgKey = 'command_exec_timeout'
export const MsgCommandExecError: MsgKey = 'command_exec_error'
export const MsgCommandExecSuccess: MsgKey = 'command_exec_success'
export const MsgSkillsTitle: MsgKey = 'skills_title'
export const MsgSkillsEmpty: MsgKey = 'skills_empty'
export const MsgSkillsHint: MsgKey = 'skills_hint'
export const MsgConfigTitle: MsgKey = 'config_title'
export const MsgConfigHint: MsgKey = 'config_hint'
export const MsgConfigGetUsage: MsgKey = 'config_get_usage'
export const MsgConfigSetUsage: MsgKey = 'config_set_usage'
export const MsgConfigUpdated: MsgKey = 'config_updated'
export const MsgConfigKeyNotFound: MsgKey = 'config_key_not_found'
export const MsgConfigReloaded: MsgKey = 'config_reloaded'
export const MsgDoctorRunning: MsgKey = 'doctor_running'
export const MsgDoctorTitle: MsgKey = 'doctor_title'
export const MsgDoctorSummary: MsgKey = 'doctor_summary'
export const MsgRestarting: MsgKey = 'restarting'
export const MsgRestartSuccess: MsgKey = 'restart_success'
export const MsgUpgradeChecking: MsgKey = 'upgrade_checking'
export const MsgUpgradeUpToDate: MsgKey = 'upgrade_up_to_date'
export const MsgUpgradeAvailable: MsgKey = 'upgrade_available'
export const MsgUpgradeDownloading: MsgKey = 'upgrade_downloading'
export const MsgUpgradeSuccess: MsgKey = 'upgrade_success'
export const MsgUpgradeDevBuild: MsgKey = 'upgrade_dev_build'
export const MsgWebNotSupported: MsgKey = 'web_not_supported'
export const MsgWebNotEnabled: MsgKey = 'web_not_enabled'
export const MsgWebSetupSuccess: MsgKey = 'web_setup_success'
export const MsgWebNeedRestart: MsgKey = 'web_need_restart'
export const MsgWebStatus: MsgKey = 'web_status'
export const MsgAliasEmpty: MsgKey = 'alias_empty'
export const MsgAliasListHeader: MsgKey = 'alias_list_header'
export const MsgAliasAdded: MsgKey = 'alias_added'
export const MsgAliasDeleted: MsgKey = 'alias_deleted'
export const MsgAliasNotFound: MsgKey = 'alias_not_found'
export const MsgAliasUsage: MsgKey = 'alias_usage'
export const MsgTurnCompleted: MsgKey = 'turn_completed'
export const MsgProcessing: MsgKey = 'processing'
export const MsgBgTaskRunning: MsgKey = 'bg_task_running'
export const MsgBgTaskProcessing: MsgKey = 'bg_task_processing'
export const MsgNewSessionCreated: MsgKey = 'new_session_created'
export const MsgNewSessionCreatedName: MsgKey = 'new_session_created_name'
export const MsgActiveSessionCount: MsgKey = 'active_session_count'
export const MsgSessionAutoResetIdle: MsgKey = 'session_auto_reset_idle'
export const MsgSessionClosingGraceful: MsgKey = 'session_closing_graceful'
export const MsgDeleteUsage: MsgKey = 'delete_usage'
export const MsgDeleteSuccess: MsgKey = 'delete_success'
export const MsgDeleteActiveDenied: MsgKey = 'delete_active_denied'
export const MsgDeleteNotSupported: MsgKey = 'delete_not_supported'
export const MsgDeleteModeTitle: MsgKey = 'delete_mode_title'
export const MsgDeleteModeSelect: MsgKey = 'delete_mode_select'
export const MsgDeleteModeSelected: MsgKey = 'delete_mode_selected'
export const MsgDeleteModeSelectedCount: MsgKey = 'delete_mode_selected_count'
export const MsgDeleteModeDeleteSelected: MsgKey = 'delete_mode_delete_selected'
export const MsgDeleteModeCancel: MsgKey = 'delete_mode_cancel'
export const MsgDeleteModeConfirmTitle: MsgKey = 'delete_mode_confirm_title'
export const MsgDeleteModeConfirmButton: MsgKey = 'delete_mode_confirm_button'
export const MsgDeleteModeBackButton: MsgKey = 'delete_mode_back_button'
export const MsgDeleteModeEmptySelection: MsgKey = 'delete_mode_empty_selection'
export const MsgDeleteModeResultTitle: MsgKey = 'delete_mode_result_title'
export const MsgDeleteModeDeletingTitle: MsgKey = 'delete_mode_deleting_title'
export const MsgDeleteModeDeletingBody: MsgKey = 'delete_mode_deleting_body'
export const MsgDeleteModeMissingSession: MsgKey = 'delete_mode_missing_session'
export const MsgSwitchSuccess: MsgKey = 'switch_success'
export const MsgSwitchNoMatch: MsgKey = 'switch_no_match'
export const MsgSwitchNoSession: MsgKey = 'switch_no_session'
export const MsgSwitchResendTitle: MsgKey = 'switch_resend_title'
export const MsgSwitchResendHeader: MsgKey = 'switch_resend_header'
export const MsgCommandTimeout: MsgKey = 'command_timeout'
export const MsgStallRetry: MsgKey = 'stall_retry'
export const MsgStallTimeout: MsgKey = 'stall_timeout'
export const MsgWatchdogReset: MsgKey = 'watchdog_reset'
export const MsgBannedWordBlocked: MsgKey = 'banned_word_blocked'
export const MsgCommandDisabled: MsgKey = 'command_disabled'
export const MsgAdminRequired: MsgKey = 'admin_required'
export const MsgRateLimited: MsgKey = 'rate_limited'
export const MsgErrProviderModelUnavailable: MsgKey = 'err_provider_model_unavailable'
export const MsgErrProviderAuth: MsgKey = 'err_provider_auth'
export const MsgErrProviderQuota: MsgKey = 'err_provider_quota'
export const MsgErrProviderRateLimit: MsgKey = 'err_provider_rate_limit'
export const MsgErrProviderNetwork: MsgKey = 'err_provider_network'
export const MsgErrProviderTimeout: MsgKey = 'err_provider_timeout'
export const MsgEmptyResult: MsgKey = 'empty_result'
export const MsgEmptyResultWithReason: MsgKey = 'empty_result_with_reason'
export const MsgBtwSent: MsgKey = 'btw_sent'
export const MsgBtwSendFailed: MsgKey = 'btw_send_failed'
export const MsgBtwEmpty: MsgKey = 'btw_empty'
export const MsgBtwTimeout: MsgKey = 'btw_timeout'
export const MsgBtwNoSession: MsgKey = 'btw_no_session'
export const MsgPsSent: MsgKey = 'ps_sent'
export const MsgSilentReply: MsgKey = 'silent_reply'
export const MsgPsSendFailed: MsgKey = 'ps_send_failed'
export const MsgPsEmpty: MsgKey = 'ps_empty'
export const MsgPsNoSession: MsgKey = 'ps_no_session'
export const MsgWhoamiTitle: MsgKey = 'whoami_title'
export const MsgWhoamiCardTitle: MsgKey = 'whoami_card_title'
export const MsgWhoamiName: MsgKey = 'whoami_name'
export const MsgWhoamiPlatform: MsgKey = 'whoami_platform'
export const MsgWhoamiUsage: MsgKey = 'whoami_usage'
export const MsgRelayNoBinding: MsgKey = 'relay_no_binding'
export const MsgRelayBound: MsgKey = 'relay_bound'
export const MsgRelayBindRemoved: MsgKey = 'relay_bind_removed'
export const MsgRelayBindNotFound: MsgKey = 'relay_bind_not_found'
export const MsgRelayBindSuccess: MsgKey = 'relay_bind_success'
export const MsgRelayUsage: MsgKey = 'relay_usage'
export const MsgRelayNotAvailable: MsgKey = 'relay_not_available'
export const MsgRelayUnbound: MsgKey = 'relay_unbound'
export const MsgRelayBindSelf: MsgKey = 'relay_bind_self'
export const MsgRelayNotFound: MsgKey = 'relay_not_found'
export const MsgRelayNoTarget: MsgKey = 'relay_no_target'
export const MsgRelaySetupHint: MsgKey = 'relay_setup_hint'
export const MsgRelaySetupOK: MsgKey = 'relay_setup_ok'
export const MsgRelaySetupExists: MsgKey = 'relay_setup_exists'
export const MsgRelaySetupNoMemory: MsgKey = 'relay_setup_no_memory'
export const MsgSetupNative: MsgKey = 'setup_native'
export const MsgCronSetupOK: MsgKey = 'cron_setup_ok'
export const MsgSearchUsage: MsgKey = 'search_usage'
export const MsgSearchError: MsgKey = 'search_error'
export const MsgSearchNoResult: MsgKey = 'search_no_result'
export const MsgSearchResult: MsgKey = 'search_result'
export const MsgSearchHint: MsgKey = 'search_hint'
export const MsgBuiltinCmdNew: MsgKey = 'new'
export const MsgBuiltinCmdList: MsgKey = 'list'
export const MsgBuiltinCmdSearch: MsgKey = 'search'
export const MsgBuiltinCmdSwitch: MsgKey = 'switch'
export const MsgBuiltinCmdDelete: MsgKey = 'delete'
export const MsgBuiltinCmdName: MsgKey = 'name'
export const MsgBuiltinCmdCurrent: MsgKey = 'current'
export const MsgBuiltinCmdHistory: MsgKey = 'history'
export const MsgBuiltinCmdProvider: MsgKey = 'provider'
export const MsgBuiltinCmdMemory: MsgKey = 'memory'
export const MsgBuiltinCmdAllow: MsgKey = 'allow'
export const MsgBuiltinCmdModel: MsgKey = 'model'
export const MsgBuiltinCmdReasoning: MsgKey = 'reasoning'
export const MsgBuiltinCmdMode: MsgKey = 'mode'
export const MsgBuiltinCmdLang: MsgKey = 'lang'
export const MsgBuiltinCmdQuiet: MsgKey = 'quiet'
export const MsgBuiltinCmdCompress: MsgKey = 'compress'
export const MsgBuiltinCmdStop: MsgKey = 'stop'
export const MsgBuiltinCmdCron: MsgKey = 'cron'
export const MsgBuiltinCmdCommands: MsgKey = 'commands'
export const MsgBuiltinCmdAlias: MsgKey = 'alias'
export const MsgBuiltinCmdSkills: MsgKey = 'skills'
export const MsgBuiltinCmdConfig: MsgKey = 'config'
export const MsgBuiltinCmdDoctor: MsgKey = 'doctor'
export const MsgBuiltinCmdUpgrade: MsgKey = 'upgrade'
export const MsgBuiltinCmdRestart: MsgKey = 'restart'
export const MsgBuiltinCmdStatus: MsgKey = 'status'
export const MsgBuiltinCmdUsage: MsgKey = 'usage'
export const MsgBuiltinCmdVersion: MsgKey = 'version'
export const MsgBuiltinCmdHelp: MsgKey = 'help'
export const MsgBuiltinCmdBind: MsgKey = 'bind'
export const MsgBuiltinCmdShell: MsgKey = 'shell'
export const MsgBuiltinCmdDir: MsgKey = 'dir'
export const MsgBuiltinCmdMonitor: MsgKey = 'monitor'
export const MsgBuiltinCmdDiff: MsgKey = 'diff'
export const MsgBuiltinCmdPs: MsgKey = 'ps'
export const MsgDiffEmpty: MsgKey = 'diff_empty'
export const MsgDiffNoDiff2HTML: MsgKey = 'diff_no_diff2html'
export const MsgDirChanged: MsgKey = 'dir_changed'
export const MsgDirCurrent: MsgKey = 'dir_current'
export const MsgDirReset: MsgKey = 'dir_reset'
export const MsgDirUsage: MsgKey = 'dir_usage'
export const MsgMonitorUsage: MsgKey = 'monitor_usage'
export const MsgMonitorDisabled: MsgKey = 'monitor_disabled'
export const MsgMonitorAdded: MsgKey = 'monitor_added'
export const MsgMonitorAlready: MsgKey = 'monitor_already'
export const MsgMonitorRemoved: MsgKey = 'monitor_removed'
export const MsgMonitorNotInList: MsgKey = 'monitor_not_in_list'
export const MsgMonitorListTitle: MsgKey = 'monitor_list_title'
export const MsgMonitorListEmpty: MsgKey = 'monitor_list_empty'
export const MsgMonitorStarMode: MsgKey = 'monitor_star_mode'
export const MsgMonitorSaveFailed: MsgKey = 'monitor_save_failed'
export const MsgMonitorNoChat: MsgKey = 'monitor_no_chat'
export const MsgMonitorModeUsage: MsgKey = 'monitor_mode_usage'
export const MsgMonitorModeCurrent: MsgKey = 'monitor_mode_current'
export const MsgMonitorModeSet: MsgKey = 'monitor_mode_set'
export const MsgMonitorModeBad: MsgKey = 'monitor_mode_bad'
export const MsgMonitorModeNoDirs: MsgKey = 'monitor_mode_no_dirs'
export const MsgMonitorDispatchGroupName: MsgKey = 'monitor_dispatch_group_name'
export const MsgMonitorModeSetDispatchHub: MsgKey = 'monitor_mode_set_dispatch_hub'
export const MsgMonitorSpawnFailed: MsgKey = 'monitor_spawn_failed'
export const MsgMonitorClarifyTimeout: MsgKey = 'monitor_clarify_timeout'
export const MsgMonitorClarifyCancelled: MsgKey = 'monitor_clarify_cancelled'
export const MsgMonitorPullGroupTitle: MsgKey = 'monitor_pull_group_title'
export const MsgMonitorDispatchTitle: MsgKey = 'monitor_dispatch_title'
export const MsgMonitorJumpBtn: MsgKey = 'monitor_jump_btn'
export const MsgDirNotSupported: MsgKey = 'dir_not_supported'
export const MsgDirInvalidPath: MsgKey = 'dir_invalid_path'
export const MsgDirHistoryTitle: MsgKey = 'dir_history_title'
export const MsgDirHistoryHint: MsgKey = 'dir_history_hint'
export const MsgDirInvalidIndex: MsgKey = 'dir_invalid_index'
export const MsgDirNoHistory: MsgKey = 'dir_no_history'
export const MsgDirNoPrevious: MsgKey = 'dir_no_previous'
export const MsgDirCardTitle: MsgKey = 'dir_card_title'
export const MsgDirCardPageHint: MsgKey = 'dir_card_page_hint'
export const MsgDirCardEmptyHistory: MsgKey = 'dir_card_empty_history'
export const MsgDirCardReset: MsgKey = 'dir_card_reset'
export const MsgDirCardPrev: MsgKey = 'dir_card_prev'
export const MsgDirSessionReset: MsgKey = 'dir_session_reset'
export const MsgShow: MsgKey = 'show'
export const MsgShowUsage: MsgKey = 'show_usage'
export const MsgShowParseError: MsgKey = 'show_parse_error'
export const MsgShowNotFound: MsgKey = 'show_not_found'
export const MsgShowDirWithLocation: MsgKey = 'show_dir_with_location'
export const MsgShowReadFailed: MsgKey = 'show_read_failed'
export const MsgWsNotEnabled: MsgKey = 'ws_not_enabled'
export const MsgWsNoBinding: MsgKey = 'ws_no_binding'
export const MsgWsInfo: MsgKey = 'ws_info'
export const MsgWsInfoShared: MsgKey = 'ws_info_shared'
export const MsgWsUsage: MsgKey = 'ws_usage'
export const MsgWsInitUsage: MsgKey = 'ws_init_usage'
export const MsgWsBindUsage: MsgKey = 'ws_bind_usage'
export const MsgWsBindSuccess: MsgKey = 'ws_bind_success'
export const MsgWsBindNotFound: MsgKey = 'ws_bind_not_found'
export const MsgWsRouteUsage: MsgKey = 'ws_route_usage'
export const MsgWsRouteSuccess: MsgKey = 'ws_route_success'
export const MsgWsRouteAbsoluteRequired: MsgKey = 'ws_route_absolute_required'
export const MsgWsRouteNotFound: MsgKey = 'ws_route_not_found'
export const MsgWsRouteNotDirectory: MsgKey = 'ws_route_not_directory'
export const MsgWsUnbindSuccess: MsgKey = 'ws_unbind_success'
export const MsgWsListEmpty: MsgKey = 'ws_list_empty'
export const MsgWsListTitle: MsgKey = 'ws_list_title'
export const MsgWsSharedNoBinding: MsgKey = 'ws_shared_no_binding'
export const MsgWsSharedUsage: MsgKey = 'ws_shared_usage'
export const MsgWsSharedBindSuccess: MsgKey = 'ws_shared_bind_success'
export const MsgWsSharedRouteSuccess: MsgKey = 'ws_shared_route_success'
export const MsgWsSharedUnbindSuccess: MsgKey = 'ws_shared_unbind_success'
export const MsgWsSharedListEmpty: MsgKey = 'ws_shared_list_empty'
export const MsgWsSharedListTitle: MsgKey = 'ws_shared_list_title'
export const MsgWsSharedOnlyHint: MsgKey = 'ws_shared_only_hint'
export const MsgWsNotFoundHint: MsgKey = 'ws_not_found_hint'
export const MsgWsResolutionError: MsgKey = 'ws_resolution_error'
export const MsgWsCloneProgress: MsgKey = 'ws_clone_progress'
export const MsgWsCloneSuccess: MsgKey = 'ws_clone_success'
export const MsgWsCloneFailed: MsgKey = 'ws_clone_failed'
export const MsgWsInitDirNotFound: MsgKey = 'ws_init_dir_not_found'
export const MsgWsInitInvalidTarget: MsgKey = 'ws_init_invalid_target'
export const MsgBackgroundAutoDenied: MsgKey = 'background_auto_denied'
export const MsgSpawnUsage: MsgKey = 'spawn_usage'
export const MsgSpawnNotSupported: MsgKey = 'spawn_not_supported'
export const MsgSpawnError: MsgKey = 'spawn_error'
export const MsgSpawnDirError: MsgKey = 'spawn_dir_error'
export const MsgSpawnGroupReady: MsgKey = 'spawn_group_ready'
export const MsgSpawnMemoryWarnTitle: MsgKey = 'spawn_memory_warn_title'
export const MsgSpawnMemoryWarn: MsgKey = 'spawn_memory_warn'
export const MsgSpawnMemoryBlockTitle: MsgKey = 'spawn_memory_block_title'
export const MsgSpawnMemoryBlock: MsgKey = 'spawn_memory_block'
export const MsgForkGroupReady: MsgKey = 'fork_group_ready'
export const MsgForkNoContext: MsgKey = 'fork_no_context'
export const MsgSpawnUnknownFlag: MsgKey = 'spawn_unknown_flag'
export const MsgForkUnknownFlag: MsgKey = 'fork_unknown_flag'
export const MsgForkCrossWorkDirDegraded: MsgKey = 'fork_cross_workdir_degraded'
export const MsgSessionResumeDegraded: MsgKey = 'session_resume_degraded'
export const MsgForkAtTruncateFailed: MsgKey = 'fork_at_truncate_failed'
export const MsgForkAtNotSupported: MsgKey = 'fork_at_not_supported'
export const MsgDoneUnknownFlag: MsgKey = 'done_unknown_flag'
export const MsgProviderUnknownFlag: MsgKey = 'provider_unknown_flag'
export const MsgRenameSpawnedOnly: MsgKey = 'rename_spawned_only'
export const MsgRenameNotSupported: MsgKey = 'rename_not_supported'
export const MsgRenameNoHistory: MsgKey = 'rename_no_history'
export const MsgRenameBackendNotSupported: MsgKey = 'rename_backend_not_supported'
export const MsgRenameUnchanged: MsgKey = 'rename_unchanged'
export const MsgRenameFailed: MsgKey = 'rename_failed'
export const MsgRenameError: MsgKey = 'rename_error'
export const MsgRenameDone: MsgKey = 'rename_done'
export const MsgDoneNotSupported: MsgKey = 'done_not_supported'
export const MsgDoneError: MsgKey = 'done_error'
export const MsgDoneReplyNoParent: MsgKey = 'done_reply_no_parent'
export const MsgDonePrivateNotAllowed: MsgKey = 'done_private_not_allowed'
export const MsgSubtaskSendNotChild: MsgKey = 'subtask_send_not_child'
export const MsgSubtaskFollowupHeader: MsgKey = 'subtask_followup_header'
export const MsgSubtaskChildBusy: MsgKey = 'subtask_child_busy'
export const MsgDoneRecursiveSummary: MsgKey = 'done_recursive_summary'
export const MsgDoneDirtyChildren: MsgKey = 'done_dirty_children'
export const MsgSubtaskDiffSummary: MsgKey = 'subtask_diff_summary'
export const MsgSubtaskTimeout: MsgKey = 'subtask_timeout'
export const MsgSubtaskGatherNoPending: MsgKey = 'subtask_gather_no_pending'
export const MsgDashDoneTip: MsgKey = 'dash_done_tip'
export const MsgDashDoneDirty: MsgKey = 'dash_done_dirty'
export const MsgWorktreeNotGit: MsgKey = 'worktree_not_git'
export const MsgWorktreeCreateError: MsgKey = 'worktree_create_error'
export const MsgWorktreeRemoved: MsgKey = 'worktree_removed'
export const MsgWorktreeRemovedShort: MsgKey = 'worktree_removed_short'
export const MsgWorktreeKept: MsgKey = 'worktree_kept'
export const MsgWorktreeDirtyPrompt: MsgKey = 'worktree_dirty_prompt'
export const MsgWorktreeCardTitle: MsgKey = 'worktree_card_title'
export const MsgWorktreeKeepBtn: MsgKey = 'worktree_keep_btn'
export const MsgWorktreeRemoveBtn: MsgKey = 'worktree_remove_btn'
export const MsgWorktreeOrphanCleaned: MsgKey = 'worktree_orphan_cleaned'
export const MsgWorktreeOrphanKept: MsgKey = 'worktree_orphan_kept'
export const MsgWorktreeOrphanDirLabel: MsgKey = 'worktree_orphan_dir_label'
export const MsgWorktreeMemoryWarn: MsgKey = 'worktree_memory_warn'
export const MsgDoneReplyParentHeader: MsgKey = 'done_reply_parent_header'
export const MsgNotifyNoChildren: MsgKey = 'notify_no_children'
export const MsgTagNotSupported: MsgKey = 'tag_not_supported'
export const MsgTagError: MsgKey = 'tag_error'
export const MsgUndoneNotSupported: MsgKey = 'undone_not_supported'
export const MsgUndoneError: MsgKey = 'undone_error'
export const MsgUntagNotSupported: MsgKey = 'untag_not_supported'
export const MsgUntagError: MsgKey = 'untag_error'
export const MsgBuiltinCmdSpawn: MsgKey = 'spawn'
export const MsgBuiltinCmdFork: MsgKey = 'fork'
export const MsgBuiltinCmdDone: MsgKey = 'done'
export const MsgBuiltinCmdNotify: MsgKey = 'notify'
export const MsgBuiltinCmdBoard: MsgKey = 'board'
export const MsgBuiltinCmdChatroom: MsgKey = 'chatroom'
export const MsgChatroomUsage: MsgKey = 'chatroom_usage'
export const MsgForkUsage: MsgKey = 'fork_usage'
export const MsgDoneUsage: MsgKey = 'done_usage'
export const MsgNotifyUsage: MsgKey = 'notify_usage'
export const MsgNewUsage: MsgKey = 'new_usage'
export const MsgListUsage: MsgKey = 'list_usage'
export const MsgHistoryUsage: MsgKey = 'history_usage'
export const MsgAllowUsage: MsgKey = 'allow_usage'
export const MsgUpgradeUsage: MsgKey = 'upgrade_usage'
export const MsgWebUsage: MsgKey = 'web_usage'
export const MsgDiffUsage: MsgKey = 'diff_usage'
export const MsgBtwUsage: MsgKey = 'btw_usage'
export const MsgPsUsage: MsgKey = 'ps_usage'
export const MsgBoardUsage: MsgKey = 'board_usage'
export const MsgSwitchUsage: MsgKey = 'switch_usage'
export const MsgShellUsage: MsgKey = 'shell_usage'
export const MsgProviderUsage: MsgKey = 'provider_usage'
export const MsgLangUsage: MsgKey = 'lang_usage'
export const MsgHelpUnknownCmd: MsgKey = 'help_unknown_cmd'
export const MsgHelpNoUsage: MsgKey = 'help_no_usage'
export const MsgBuiltinCmdBtw: MsgKey = 'btw'
export const MsgBuiltinCmdWeb: MsgKey = 'web'
export const MsgHintsEmpty: MsgKey = 'hints_empty'
export const MsgBuiltinCmdHint: MsgKey = 'hint'
export const MsgAttachmentsStaged: MsgKey = 'attachments_staged'
export const MsgAttachmentsDiscarded: MsgKey = 'attachments_discarded'
export const MsgChatroomReady: MsgKey = 'chatroom_ready'
export const MsgChatroomTopicLabel: MsgKey = 'chatroom_topic_label'
export const MsgChatroomUnknownRole: MsgKey = 'chatroom_unknown_role'
export const MsgChatroomAskHeader: MsgKey = 'chatroom_ask_header'
export const MsgChatroomAskNotInRoom: MsgKey = 'chatroom_ask_not_in_room'
export const MsgChatroomRoleNotFound: MsgKey = 'chatroom_role_not_found'
export const MsgChatroomReminder: MsgKey = 'chatroom_reminder'
export const MsgChatroomRoleReplyHeader: MsgKey = 'chatroom_role_reply_header'
export const MsgChatroomGatherTimedOutDispatched: MsgKey = 'chatroom_gather_timed_out_dispatched'
export const MsgChatroomGatherTimedOutInFlight: MsgKey = 'chatroom_gather_timed_out_in_flight'
export const MsgChatroomGatherTimedOutIdle: MsgKey = 'chatroom_gather_timed_out_idle'
export const MsgChatroomResearchProgressTitle: MsgKey = 'chatroom_research_progress_title'
export const MsgChatroomResearchProgressBody: MsgKey = 'chatroom_research_progress_body'
export const MsgChatroomResearchProgressDone: MsgKey = 'chatroom_research_progress_done'
export const MsgChatroomResearchProgressTimedOut: MsgKey = 'chatroom_research_progress_timed_out'
export const MsgChatroomResearchProgressTimedOutTitle: MsgKey = 'chatroom_research_progress_timed_out_title'
export const MsgChatroomMaxRoundsRange: MsgKey = 'chatroom_max_rounds_range'
export const MsgChatroomResearchSingleRole: MsgKey = 'chatroom_research_single_role'
export const MsgChatroomResearchAskTimeout: MsgKey = 'chatroom_research_ask_timeout'
export const MsgChatroomPendingHeader: MsgKey = 'chatroom_pending_header'
export const MsgChatroomPendingBody: MsgKey = 'chatroom_pending_body'
export const MsgChatroomConcluded: MsgKey = 'chatroom_concluded'
export const MsgChatroomNoRoles: MsgKey = 'chatroom_no_roles'
export const MsgChatroomNoRolesConfigured: MsgKey = 'chatroom_no_roles_configured'
export const MsgChatroomResearchNeedsUv: MsgKey = 'chatroom_research_needs_uv'
export const MsgChatroomListTitle: MsgKey = 'chatroom_list_title'
export const MsgChatroomRoleInited: MsgKey = 'chatroom_role_inited'
export const MsgChatroomGatherHeader: MsgKey = 'chatroom_gather_header'
export const MsgChatroomGatherTimeout: MsgKey = 'chatroom_gather_timeout'
export const MsgChatroomDirectStarted: MsgKey = 'chatroom_direct_started'
export const MsgChatroomPickTitle: MsgKey = 'chatroom_pick_title'
export const MsgChatroomPickRecommended: MsgKey = 'chatroom_pick_recommended'
export const MsgChatroomPickSelect: MsgKey = 'chatroom_pick_select'
export const MsgChatroomPickSelected: MsgKey = 'chatroom_pick_selected'
export const MsgChatroomPickSelectedCount: MsgKey = 'chatroom_pick_selected_count'
export const MsgChatroomPickConfirm: MsgKey = 'chatroom_pick_confirm'
export const MsgChatroomPickCancel: MsgKey = 'chatroom_pick_cancel'
export const MsgChatroomPickCancelled: MsgKey = 'chatroom_pick_cancelled'
export const MsgChatroomPickEmpty: MsgKey = 'chatroom_pick_empty'
export const MsgChatroomPickTooMany: MsgKey = 'chatroom_pick_too_many'
export const MsgChatroomPickPicking: MsgKey = 'chatroom_pick_picking'
export const MsgChatroomPickStarting: MsgKey = 'chatroom_pick_starting'
export const MsgChatroomTopicPickTitle: MsgKey = 'chatroom_topic_pick_title'
export const MsgChatroomTopicPickPicking: MsgKey = 'chatroom_topic_pick_picking'
export const MsgChatroomTopicPickPick: MsgKey = 'chatroom_topic_pick_pick'
export const MsgChatroomTopicPickPicked: MsgKey = 'chatroom_topic_pick_picked'
export const MsgChatroomTopicPickPickedHint: MsgKey = 'chatroom_topic_pick_picked_hint'
export const MsgChatroomTopicPickNotSelected: MsgKey = 'chatroom_topic_pick_not_selected'
export const MsgChatroomTopicPickConfirm: MsgKey = 'chatroom_topic_pick_confirm'
export const MsgChatroomTopicPickCancel: MsgKey = 'chatroom_topic_pick_cancel'
export const MsgChatroomTopicPickCancelled: MsgKey = 'chatroom_topic_pick_cancelled'
export const MsgChatroomTopicPickEmpty: MsgKey = 'chatroom_topic_pick_empty'
export const MsgChatroomTopicPickStarting: MsgKey = 'chatroom_topic_pick_starting'
export const MsgChatroomTopicPickWatchdogHint: MsgKey = 'chatroom_topic_pick_watchdog_hint'
export const MsgChatroomGatherAskHumanBlocked: MsgKey = 'chatroom_gather_ask_human_blocked'
