import { PHONE_ACTION_CAPABILITIES, type ActionDecision, type PhoneAction, type PhoneActionRequest } from './protocol.ts';

/** 手机伴侣的最小安全策略：非白名单动作不存在；敏感动作必须由用户确认。 */
export const PHONE_ACTION_POLICY: Readonly<Record<PhoneAction, ActionDecision>> = Object.fromEntries(
    PHONE_ACTION_CAPABILITIES.map(capability => [capability.action, capability.defaultDecision]),
) as Record<PhoneAction, ActionDecision>;

export function decidePhoneAction(request: PhoneActionRequest, confirmed: boolean): ActionDecision {
    const expected = PHONE_ACTION_POLICY[request.action];
    if (!expected) return 'deny';
    if (request.decision === 'deny') return 'deny';
    if (expected === 'confirm' || request.decision === 'confirm') return confirmed ? 'confirm' : 'deny';
    return 'auto';
}

export function actionNeedsConfirmation(action: PhoneAction): boolean {
    return PHONE_ACTION_POLICY[action] === 'confirm';
}
