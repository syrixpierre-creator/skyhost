use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or("3000".into());
    let app = Router::new().route("/", get(|| async { "Hello" }));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    let _db = std::env::var("DATABASE_URL").unwrap();
    axum::serve(listener, app).await.unwrap();
}
