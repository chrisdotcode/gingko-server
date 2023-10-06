import _ from "lodash";

export type CollabInfo = {uuid: string, userId: string, ws: WebSocket};
type CollabInfoMap = Map<string, CollabInfo[]>;

function addClientToTreeChannel(treeToCollabInfo : CollabInfoMap, collabInfo : CollabInfo, treeId : string) {
  const currentCollabInfos = treeToCollabInfo.get(treeId);
  if (currentCollabInfos) {
    treeToCollabInfo.set(treeId, _.uniqBy([...currentCollabInfos, collabInfo], 'uuid'));
  } else {
    treeToCollabInfo.set(treeId, [collabInfo]);
  }
}

function removeClientFromAllTreeChannels(treeToCollabInfo : CollabInfoMap, collabInfo : CollabInfo) {
  for (const [treeId, collabInfos] of treeToCollabInfo) {
    treeToCollabInfo.set(treeId, collabInfos.filter(ci => ci.uuid !== collabInfo.uuid));
  }
  deleteEmptyTreeChannels(treeToCollabInfo);
}

function removeClientFromAllTreeChannelsByWs(treeToCollabInfo : CollabInfoMap, ws : WebSocket) {
  for (const [treeId, collabInfos] of treeToCollabInfo) {
    treeToCollabInfo.set(treeId, collabInfos.filter(ci => ci.ws !== ws));
  }
  deleteEmptyTreeChannels(treeToCollabInfo);
}

function messageToTreeChannel(treeToCollabInfo : CollabInfoMap, treeId : string, message : any) {
  const collabInfos = treeToCollabInfo.get(treeId);
  if (collabInfos) {
    for (const collabInfo of collabInfos) {
      collabInfo.ws.send(JSON.stringify(message));
    }
  }
}

function messageToOthersInTreeChannel(treeToCollabInfo : CollabInfoMap, treeId : string, collabInfo : CollabInfo, message : any) {
  const collabInfos = treeToCollabInfo.get(treeId);
  if (collabInfos) {
    for (const ci of collabInfos) {
      if (ci.uuid !== collabInfo.uuid) {
        ci.ws.send(JSON.stringify(message));
      }
    }
  }
}

function messageToOthersInTreeByWs(treeToCollabInfo : CollabInfoMap, ws : WebSocket, message : any) {
  for (const [treeId, collabInfos] of treeToCollabInfo) {
    for (const ci of collabInfos) {
      if (ci.ws !== ws) {
        ci.ws.send(JSON.stringify(message));
      }
    }
  }
}

function deleteEmptyTreeChannels(treeToCollabInfo : CollabInfoMap) {
  for (const [treeId, collabInfos] of treeToCollabInfo) {
    if (collabInfos.length === 0) {
      treeToCollabInfo.delete(treeId);
    }
  }
}

export function handleRT(treeToCollabInfo : CollabInfoMap, collabInfo : CollabInfo, treeId : string, message : any) {
  addClientToTreeChannel(treeToCollabInfo, collabInfo, treeId);
  messageToOthersInTreeChannel(treeToCollabInfo, treeId, collabInfo,
    {
      t: 'rt',
      d: {
        u: collabInfo.userId, uid: collabInfo.uuid, m: message
      }
    });
}

export function clientDisconnect(treeToCollabInfo : CollabInfoMap, ws: WebSocket) {
  const collabInfo = [...treeToCollabInfo.values()].flatMap(x => x).find(ci => ci.ws === ws);
  if (!collabInfo) { return; }

  messageToOthersInTreeByWs(treeToCollabInfo, ws,
    {
      t: 'rt',
      d: {
        u: collabInfo.userId, uid: collabInfo.uuid, m: ["d", ""]
      }
    });
  removeClientFromAllTreeChannelsByWs(treeToCollabInfo, ws);
}