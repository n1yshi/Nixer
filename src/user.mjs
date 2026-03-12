export const SIMULATED_USER_TOKEN = "SIMULATED"
export const LOCAL_USER_TOKEN = "LOCAL"

export function newSimulatedUser() {
  return {
    viewer: {
      name: "User",
      avatar: null,
      bannerImage: null,
      isBlocked: null,
      options: null
    },
    token: SIMULATED_USER_TOKEN,
    isSimulated: true
  }
}

export function newLocalUser(username, avatarPath = "") {
  return {
    viewer: {
      name: username,
      avatar: avatarPath
        ? {
            medium: avatarPath,
            large: avatarPath
          }
        : null
    },
    token: LOCAL_USER_TOKEN,
    isSimulated: false
  }
}
