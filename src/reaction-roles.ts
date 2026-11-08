import { getSetting, setSetting } from './db';

export type ReactionRoleMapping={emoji:string;emojiKey?:string;roleId:string};
export type ReactionRolePanel={channelId:string;messageId:string;title:string;description:string;mappings:ReactionRoleMapping[]};

export function getReactionRolePanels():ReactionRolePanel[] {
  const current=getSetting<ReactionRolePanel[]|null>('reactionRolePanels',null);
  if(Array.isArray(current))return current;
  const legacy=getSetting<ReactionRolePanel|null>('reactionRolePanel',null);
  return legacy?.messageId?[legacy]:[];
}

export function saveReactionRolePanels(panels:ReactionRolePanel[]):void {
  setSetting('reactionRolePanels',panels);
}
