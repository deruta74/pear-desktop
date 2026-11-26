use std::{io, path::PathBuf};

use serde::Serialize;

use crate::library::{
    Library,
    playlists::{Command, Playlist, Playlists},
};

pub(super) struct Panel {
    store: Result<Playlists, String>,
    selected: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View<'a> {
    lists: Vec<Summary<'a>>,
    selected: Option<&'a Playlist>,
    problem: Option<&'a str>,
    can_save: bool,
}

#[derive(Serialize)]
struct Summary<'a> {
    id: u32,
    name: &'a str,
    count: usize,
}

impl Panel {
    pub(super) fn load(path: PathBuf) -> Self {
        Self {
            store: Playlists::load(path).map_err(|error| error.to_string()),
            selected: None,
        }
    }

    pub(super) fn apply(&mut self, command: Command, queue: &mut Library) -> io::Result<bool> {
        let store = self
            .store
            .as_mut()
            .map_err(|problem| io::Error::other(problem.clone()))?;
        match command {
            Command::SavePlaylist { name } => store.save_queue(&name, queue.state())?,
            Command::OpenPlaylist { id } => self.selected = Some(store.get(id)?.id),
            Command::ClosePlaylist {} => self.selected = None,
            Command::RenamePlaylist { id, name } => store.rename(id, &name)?,
            Command::RemovePlaylist { id } => {
                store.remove(id)?;
                if self.selected == Some(id) {
                    self.selected = None;
                }
            }
            Command::AppendPlaylist { id } => return queue.enqueue_saved(store.get(id)?, None),
            Command::SelectPlaylistTrack { id, video } => {
                return queue.enqueue_saved(store.get(id)?, Some(&video));
            }
        }
        Ok(false)
    }

    pub(super) fn view(&self) -> View<'_> {
        let store = self.store.as_ref().ok();
        View {
            lists: store
                .map_or(&[][..], Playlists::entries)
                .iter()
                .map(|playlist| Summary {
                    id: playlist.id,
                    name: &playlist.name,
                    count: playlist.entries.len(),
                })
                .collect(),
            selected: store
                .zip(self.selected)
                .and_then(|(store, id)| store.get(id).ok()),
            problem: self.store.as_ref().err().map(String::as_str),
            can_save: store.is_some(),
        }
    }
}
