# Política de Privacidade

Última atualização: 7 de setembro de 2026

## Introdução

O Voyager ("nós", "nosso" ou "nos") está comprometido em proteger a sua privacidade. Esta Política de Privacidade explica como a nossa extensão de navegador recolhe, utiliza e protege as suas informações.

## Recolha e Utilização de Dados

**Não recolhemos nenhuma informação pessoal.**

O Voyager opera inteiramente dentro do seu navegador. Todos os dados gerados ou geridos pela extensão (como pastas, modelos de prompts, mensagens favoritas e configurações) são armazenados:

1. Localmente no seu dispositivo (`chrome.storage.local`)
2. No armazenamento sincronizado do seu navegador (`chrome.storage.sync`) se disponível, para sincronizar configurações entre os seus dispositivos.

Não temos acesso aos seus dados pessoais, histórico de chat ou qualquer outra informação privada. Não rastreamos o seu histórico de navegação.

## Sincronização com Google Drive (Opcional)

Se ativar a sincronização com o Google Drive, Chrome, Edge e Firefox utilizam a API de identidade do navegador; a aplicação Safari de distribuição direta utiliza o Google Sign-In nativo e guarda as credenciais no Porta-chaves do macOS. Ambos os caminhos solicitam apenas o scope limitado `drive.file` e transferem os dados diretamente entre o seu dispositivo e **o seu próprio Google Drive**. Os tokens OAuth não são enviados para nenhum servidor Voyager.

## Atualizações online do catálogo de plugins (opcional)

Num site onde tenha ativado pelo menos um plugin, o Voyager pode pedir por HTTPS o ficheiro de catálogo desse site em `https://voyager.nagi.fun/catalog/hosts/<host do site>.json`, por exemplo `https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`. A verificação só acontece ao abrir uma página desse tipo ou ao abrir a janela da extensão nessa página, e apenas se a última verificação for mais antiga do que o intervalo que escolheu (6 horas por predefinição; 1 hora, 6 horas, 24 horas ou apenas manual). As páginas do Gemini e do AI Studio não têm plugins, pelo que nunca originam um pedido. O pedido é um GET simples que não envia cookies, identificadores de conta ou da extensão, nem conteúdo da página ou da conversa; tal como em qualquer pedido web, o servidor vê o endereço IP de origem e o user agent do navegador, além do nome de host do site no caminho do URL. Nos sites com plugins, a janela da extensão oferece um interruptor «Atualizações online de plugins» e o seletor de intervalo; ambas as definições ficam guardadas no armazenamento sincronizado do navegador e são incluídas na cópia de segurança das definições. Com o interruptor desligado, o Voyager não contacta voyager.nagi.fun a não ser que carregue em «Procurar atualizações de plugins agora». Se o pedido falhar ou o site não tiver ficheiro de catálogo, mantém-se em uso o instantâneo de plugins incluído na extensão. Um catálogo obtido contém apenas CSS e JSON, que são validados e sanitizados antes de serem usados; nunca é transferido nem executado JavaScript.

## Permissões

A extensão solicita as permissões mínimas necessárias para funcionar:

- **Storage (Armazenamento)**: Para guardar as suas preferências, pastas, prompts, mensagens favoritas e opções de personalização da interface localmente e entre dispositivos.
- **Identity (Identidade)**: Para a autenticação Google da funcionalidade opcional de sincronização com o Google Drive. Usado apenas quando ativa explicitamente a sincronização na nuvem.
- **Scripting (Scripts)**: Para injetar dinamicamente scripts de conteúdo nas páginas do Gemini e em sites personalizados especificados pelo utilizador para a funcionalidade Gestor de Prompts. Apenas scripts incluídos na própria extensão são injetados — nenhum código remoto é obtido ou executado.
- **Host Permissions (Permissões de host)** (gemini.google.com, aistudio.google.com, etc.): Para injetar scripts de conteúdo que melhoram a interface do Gemini com funcionalidades como pastas, exportação, linha do tempo e citação de resposta. Os domínios adicionais da Google (googleapis.com, accounts.google.com) são necessários para a autenticação da sincronização com o Google Drive.
- **Optional Host Permissions (Permissões de host opcionais)** (todos os URLs): Apenas solicitadas em tempo de execução quando adiciona explicitamente sites personalizados para o Gestor de Prompts. Nunca ativadas sem a sua ação.

## Serviços de Terceiros

O Voyager não partilha nenhuns dados com serviços de terceiros, anunciantes ou fornecedores de análises.

## Alterações a Esta Política

Podemos atualizar a nossa Política de Privacidade ocasionalmente. Iremos notificá-lo de quaisquer alterações publicando a nova Política de Privacidade nesta página.

## Contacte-nos

Se tiver alguma dúvida sobre esta Política de Privacidade, por favor contacte-nos através do nosso [Repositório GitHub](https://github.com/Nagi-ovo/voyager).
