import _ from "lodash";

export type User =
  { uuid: string
  , userId: string
  , ws: WebSocket
  };
type ChannelMap = Map<string, User[]>;

function join(channels : ChannelMap, user : User, treeId : string) {
  console.log('join', user.uuid, treeId);
  const channelUsers = channels.get(treeId);
  if (channelUsers) {
    channels.set(treeId, _.uniqBy([...channelUsers, user], 'uuid'));
  } else {
    channels.set(treeId, [user]);
  }
}

function disconnectUserByWS(channels : ChannelMap, ws : WebSocket) {
  for (const [treeId, users] of channels) {
    channels.set(treeId, users.filter(u => u.ws !== ws));
  }
  deleteEmptyTreeChannels(channels);
}

function broadcastToChannel(channels : ChannelMap, treeId : string, senderUuid : string, message : any) {
  const users = channels.get(treeId);
  if (users) {
    for (const u of users) {
      if (u.uuid !== senderUuid) {
        u.ws.send(JSON.stringify(message));
      }
    }
  }
}

function broadcastToChannelByWS(channels : ChannelMap, ws : WebSocket, message : any) {
  for (const [treeId, users] of channels) {
    for (const u of users) {
      if (u.ws !== ws) {
        u.ws.send(JSON.stringify(message));
      }
    }
  }
}

function deleteEmptyTreeChannels(channels : ChannelMap) {
  for (const [treeId, users] of channels) {
    if (users.length === 0) {
      channels.delete(treeId);
    }
  }
}

export function handleRT(channels : ChannelMap, user : User, treeId : string, message : any) {
  join(channels, user, treeId);
  broadcastToChannel(channels, treeId, user.uuid,
    {
      t: 'rt',
      d: {
        u: user.userId, uid: user.uuid, m: message
      }
    });
}

export function disconnectWebSocket(channels : ChannelMap, ws: WebSocket) {
  const user = [...channels.values()].flatMap(x => x).find(ci => ci.ws === ws);
  if (!user) { return; }

  broadcastToChannelByWS(channels, ws,
    {
      t: 'rt',
      d: {
        u: user.userId, uid: user.uuid, m: ["d", ""]
      }
    });
  disconnectUserByWS(channels, ws);
}