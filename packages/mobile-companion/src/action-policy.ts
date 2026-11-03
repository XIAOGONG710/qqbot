import type { ActionDecision, PhoneAction, PhoneActionRequest } from './protocol.ts';

/** 手机伴侣的最小安全策略：非白名单动作不存在；敏感动作必须由用户确认。 */
export const PHONE_ACTION_POLICY: Readonly<Record<PhoneAction, ActionDecision>> = {
    notify: 'auto',
    timer: 'auto',
    ring: 'confirm',
    open_link: 'confirm',
    media_control: 'confirm',
    volume: 'confirm',
};

export function decidePhoneAction(request: PhoneActionRequest, confirmed: boolean): ActionDecision {
    const expected = PHONE_ACTION_POLICY[request.action];
    if (!expected) return 'deny';
    if (expected === 'auto') return request.decision === 'deny' ? 'deny' : 'auto';
    return confirmed && request.decision !== 'deny' ? 'confirm' : 'deny';
}

export function actionNeedsConfirmation(action: PhoneAction): boolean {
    return PHONE_ACTION_POLICY[action] === 'confirm';
}
