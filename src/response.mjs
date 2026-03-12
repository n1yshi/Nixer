export function dataResponse(data) {
  return { data }
}

export function errorResponse(error, status = 400) {
  return {
    status,
    body: {
      error: error instanceof Error ? error.message : String(error || "Unknown error"),
    },
  }
}
