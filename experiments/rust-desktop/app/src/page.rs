use url::Url;

pub const YOUTUBE_MUSIC: &str = "https://music.youtube.com/";

#[derive(Clone)]
pub enum PreviewPage {
    Music,
    #[cfg(feature = "benchmark")]
    Fixture(Url),
}

impl PreviewPage {
    pub fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, &'static str> {
        match args.next().as_deref() {
            None => Ok(Self::Music),
            #[cfg(feature = "benchmark")]
            Some("--benchmark-url") => {
                let input = args.next().ok_or("Missing benchmark URL")?;
                if args.next().is_some() {
                    return Err("Unexpected arguments after the benchmark URL");
                }
                let url = Url::parse(&input).map_err(|_| "Invalid benchmark URL")?;
                if input != url.as_str()
                    || url.scheme() != "http"
                    || url.host_str() != Some("127.0.0.1")
                    || !url.port().is_some_and(|port| port >= 1024)
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || !has_no_credentials(&url)
                {
                    return Err("Benchmark URL must be http://127.0.0.1:<port>/");
                }
                Ok(Self::Fixture(url))
            }
            Some(_) => Err("Unexpected argument"),
        }
    }

    pub fn start_url(&self) -> &str {
        match self {
            Self::Music => YOUTUBE_MUSIC,
            #[cfg(feature = "benchmark")]
            Self::Fixture(url) => url.as_str(),
        }
    }

    pub fn permits(&self, input: &str) -> bool {
        let Ok(url) = Url::parse(input) else {
            return false;
        };
        match self {
            Self::Music => {
                url.scheme() == "https"
                    && url.host_str() == Some("music.youtube.com")
                    && url.port().is_none()
                    && has_no_credentials(&url)
            }
            #[cfg(feature = "benchmark")]
            Self::Fixture(fixture) => input == fixture.as_str(),
        }
    }
}

fn has_no_credentials(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none()
}
